/*
 * QST QMI8658A 6-axis IMU on I2C (used by Xteink X3 / X4 Classic profiles).
 *
 * WHO_AM_I and REVISION_ID follow the QMI8658A Rev A defaults. CTRL1-CTRL9
 * are register-backed; STATUS0 reports data-ready bits for the CTRL7-enabled
 * sensor engines. Output samples are refreshed when a read transaction
 * begins, use the guest-selected CTRL2/CTRL3 full-scale ranges, and retain
 * their last values while the corresponding engine is disabled. Host-side
 * shake injection supplies deterministic physical impulses for UI testing.
 * This is not a cycle-accurate sensor: FIFO, sample timing, interrupts and
 * on-chip motion-detection engines are not implemented.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 2 or
 * (at your option) any later version.
 */
#include "qemu/osdep.h"
#include "qemu/module.h"
#include "qapi/error.h"
#include "hw/i2c/i2c.h"

#define TYPE_QMI8658 "qmi8658"
OBJECT_DECLARE_SIMPLE_TYPE(QMI8658State, QMI8658)

#define QMI8658_NREGS   0x64
#define R_WHO_AM_I      0x00
#define R_REVISION      0x01
#define R_CTRL1         0x02
#define R_CTRL7         0x08
#define R_STATUS0       0x2E
#define R_TEMP_L        0x33
#define R_AX_L          0x35
#define R_GZ_H          0x40

struct QMI8658State {
    I2CSlave parent_obj;
    uint8_t regs[QMI8658_NREGS];
    uint8_t ptr;
    bool ptr_next;
    char *shake;
};

static int16_t qmi8658_acc_raw(QMI8658State *s, int milli_g)
{
    /* CTRL2[6:4]: +/-2, 4, 8 or 16 g. Sensitivity is 16384 LSB/g
     * at +/-2 g and halves for each successive full-scale range.
     */
    static const int sensitivity[] = { 16384, 8192, 4096, 2048 };
    unsigned int range = (s->regs[0x03] >> 4) & 7;
    int64_t raw;

    if (range >= ARRAY_SIZE(sensitivity)) {
        range = 0; /* Reserved range encodings are not specified. */
    }
    raw = (int64_t)milli_g * sensitivity[range] / 1000;
    return CLAMP(raw, INT16_MIN, INT16_MAX);
}

static int16_t qmi8658_gyro_raw(QMI8658State *s, int milli_dps)
{
    /* CTRL3[6:4]: +/-16 through +/-2048 dps. */
    static const int sensitivity[] = {
        2048, 1024, 512, 256, 128, 64, 32, 16
    };
    unsigned int range = (s->regs[0x04] >> 4) & 7;
    int64_t raw = (int64_t)milli_dps * sensitivity[range] / 1000;

    return CLAMP(raw, INT16_MIN, INT16_MAX);
}

static void qmi8658_set_sample(QMI8658State *s, uint8_t reg, int16_t value)
{
    s->regs[reg] = value & 0xff;
    s->regs[reg + 1] = (uint16_t)value >> 8;
}

static void qmi8658_latch(QMI8658State *s)
{
    uint8_t en = s->regs[R_CTRL7] & 3;

    s->regs[R_STATUS0] = en;
    /* QMI8658A temperature is TEMP_H + TEMP_L / 256 degrees Celsius. */
    s->regs[R_TEMP_L] = 0;
    s->regs[R_TEMP_L + 1] = 25;

    /* Output data is only refreshed for enabled sensor engines. The UI
     * shake control injects +/-1.5 g lateral acceleration and +/-8 dps yaw;
     * convert these physical values using the ranges currently selected by
     * the guest, independently respecting CTRL7's accel/gyro enable bits.
     */
    if (en & 1) {
        qmi8658_set_sample(s, R_AX_L + 2, 0);
        qmi8658_set_sample(s, R_AX_L + 4, qmi8658_acc_raw(s, 1000));
        if (s->shake && !strcmp(s->shake, "left")) {
            qmi8658_set_sample(s, R_AX_L, qmi8658_acc_raw(s, -1500));
        } else if (s->shake && !strcmp(s->shake, "right")) {
            qmi8658_set_sample(s, R_AX_L, qmi8658_acc_raw(s, 1500));
        } else {
            qmi8658_set_sample(s, R_AX_L, 0);
        }
    }
    if (en & 2) {
        qmi8658_set_sample(s, R_GZ_H - 5, 0);
        qmi8658_set_sample(s, R_GZ_H - 3, 0);
        if (s->shake && !strcmp(s->shake, "left")) {
            qmi8658_set_sample(s, R_GZ_H - 1, qmi8658_gyro_raw(s, 8000));
        } else if (s->shake && !strcmp(s->shake, "right")) {
            qmi8658_set_sample(s, R_GZ_H - 1, qmi8658_gyro_raw(s, -8000));
        } else {
            qmi8658_set_sample(s, R_GZ_H - 1, 0);
        }
    }
}

static int qmi8658_event(I2CSlave *i2c, enum i2c_event event)
{
    QMI8658State *s = QMI8658(i2c);

    if (event == I2C_START_SEND) {
        s->ptr_next = true;
    } else if (event == I2C_START_RECV) {
        qmi8658_latch(s);
    }
    return 0;
}

static void qmi8658_advance(QMI8658State *s)
{
    if (s->regs[R_CTRL1] & 0x40) { /* ADDR_AI */
        s->ptr = (s->ptr + 1) % QMI8658_NREGS;
    }
}

static uint8_t qmi8658_recv(I2CSlave *i2c)
{
    QMI8658State *s = QMI8658(i2c);
    uint8_t val = s->regs[s->ptr];

    qmi8658_advance(s);
    return val;
}

static int qmi8658_send(I2CSlave *i2c, uint8_t data)
{
    QMI8658State *s = QMI8658(i2c);

    if (s->ptr_next) {
        s->ptr_next = false;
        s->ptr = data % QMI8658_NREGS;
        return 0;
    }
    if (s->ptr >= R_CTRL1 && s->ptr < R_STATUS0) {
        s->regs[s->ptr] = data;
    }
    qmi8658_advance(s);
    return 0;
}

static void qmi8658_reset_hold(Object *obj, ResetType type)
{
    QMI8658State *s = QMI8658(obj);

    memset(s->regs, 0, sizeof(s->regs));
    s->regs[R_WHO_AM_I] = 0x05;
    s->regs[R_REVISION] = 0x7C;
    s->regs[R_CTRL1] = 0x20; /* Datasheet power-on default. */
    qmi8658_latch(s);
}

static char *qmi8658_get_shake(Object *obj, Error **errp)
{
    QMI8658State *s = QMI8658(obj);
    return g_strdup(s->shake ? s->shake : "none");
}

static void qmi8658_set_shake(Object *obj, const char *value, Error **errp)
{
    QMI8658State *s = QMI8658(obj);
    if (strcmp(value, "none") && strcmp(value, "left") && strcmp(value, "right")) {
        error_setg(errp, "shake must be none, left or right");
        return;
    }
    g_free(s->shake);
    s->shake = g_strdup(value);
    qmi8658_latch(s);
}

static void qmi8658_finalize(Object *obj)
{
    QMI8658State *s = QMI8658(obj);
    g_free(s->shake);
}

static void qmi8658_class_init(ObjectClass *klass, const void *data)
{
    I2CSlaveClass *k = I2C_SLAVE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);

    k->event = qmi8658_event;
    k->recv = qmi8658_recv;
    k->send = qmi8658_send;
    rc->phases.hold = qmi8658_reset_hold;
    object_class_property_add_str(klass, "shake", qmi8658_get_shake, qmi8658_set_shake);
}

static const TypeInfo qmi8658_info = {
    .name = TYPE_QMI8658,
    .parent = TYPE_I2C_SLAVE,
    .instance_size = sizeof(QMI8658State),
    .instance_finalize = qmi8658_finalize,
    .class_init = qmi8658_class_init,
};

static void qmi8658_register_types(void)
{
    type_register_static(&qmi8658_info);
}

type_init(qmi8658_register_types)
