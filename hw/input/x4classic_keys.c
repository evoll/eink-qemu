/*
 * Xteink X4 Classic physical keys: Up (GPIO0), Down (GPIO7), Left (GPIO5),
 * Right (GPIO2), Confirm (GPIO8), Back (GPIO9), Power (GPIO3), active-low.
 * Host keyboard: arrows, Enter, Escape/Backspace, and P. QOM bool properties
 * "up", "down", "left", "right", "confirm", "back", and "power" allow
 * scripted presses, for example: qom-set /machine/x4classic-keys left true.
 * "power-boot-ms" holds Power pressed that long when the RTC controller
 * signals a cold power-on ("boot" line 0), or a wake from deep sleep by a pad
 * ("boot" line 1) while Power is pressed or was pressed in the last 2 s:
 * the hand that turns the device on is still on the button while the
 * firmware checks it. Software resets, watchdog resets and timer wakes boot
 * with Power released.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 2 or
 * (at your option) any later version.
 */
#include "qemu/osdep.h"
#include "qapi/error.h"
#include "qemu/module.h"
#include "qemu/timer.h"
#include "hw/core/sysbus.h"
#include "hw/core/irq.h"
#include "hw/core/qdev-properties.h"
#include "ui/input.h"

#define TYPE_X4CLASSIC_KEYS "x4classic-keys"
OBJECT_DECLARE_SIMPLE_TYPE(X4ClassicKeysState, X4CLASSIC_KEYS)

enum { KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_CONFIRM, KEY_BACK, KEY_POWER, KEY_COUNT };

struct X4ClassicKeysState {
    SysBusDevice parent_obj;
    QemuInputHandlerState *input;
    qemu_irq out[KEY_COUNT];    /* pin level: 1 released, 0 pressed */
    QEMUTimer boot_timer;
    uint32_t power_boot_ms;
    bool boot_hold;
    bool pressed[KEY_COUNT];
    int64_t power_down_ms;      /* virtual ms Power was last pressed, or -1 */
};

/* A pad wake within this long of a Power press was that press. */
#define POWER_WAKE_WINDOW_MS 2000

static void keys_update(X4ClassicKeysState *s)
{
    for (int k = 0; k < KEY_COUNT; k++) {
        bool down = s->pressed[k] || (k == KEY_POWER && s->boot_hold);
        qemu_set_irq(s->out[k], !down);
    }
}

static void keys_set(X4ClassicKeysState *s, int k, bool down)
{
    if (k == KEY_POWER && down && !s->pressed[k]) {
        s->power_down_ms = qemu_clock_get_ms(QEMU_CLOCK_VIRTUAL);
    }
    s->pressed[k] = down;
    keys_update(s);
}

static void keys_event(DeviceState *dev, QemuConsole *src, QemuInputEvent *evt)
{
    X4ClassicKeysState *s = X4CLASSIC_KEYS(dev);
    QemuInputKeyEvent *key = &evt->key;
    int qcode = qemu_input_linux_to_qcode(key->key);
    int k = qcode == Q_KEY_CODE_UP ? KEY_UP : qcode == Q_KEY_CODE_DOWN ? KEY_DOWN
          : qcode == Q_KEY_CODE_LEFT ? KEY_LEFT : qcode == Q_KEY_CODE_RIGHT ? KEY_RIGHT
          : qcode == Q_KEY_CODE_RET ? KEY_CONFIRM
          : qcode == Q_KEY_CODE_ESC || qcode == Q_KEY_CODE_BACKSPACE ? KEY_BACK
          : qcode == Q_KEY_CODE_P ? KEY_POWER : -1;

    if (k >= 0) {
        keys_set(s, k, key->down);
    }
}

static const QemuInputHandler keys_handler = {
    .name = "X4 Classic keys",
    .mask = INPUT_EVENT_MASK_KEY,
    .event = keys_event,
};

#define KEY_PROP(name, idx)                                                    \
    static bool get_##name(Object *o, Error **e) { return X4CLASSIC_KEYS(o)->pressed[idx]; } \
    static void set_##name(Object *o, bool v, Error **e) { keys_set(X4CLASSIC_KEYS(o), idx, v); }
KEY_PROP(up, KEY_UP)
KEY_PROP(down, KEY_DOWN)
KEY_PROP(left, KEY_LEFT)
KEY_PROP(right, KEY_RIGHT)
KEY_PROP(confirm, KEY_CONFIRM)
KEY_PROP(back, KEY_BACK)
KEY_PROP(power, KEY_POWER)

static void keys_boot_release(void *opaque)
{
    X4ClassicKeysState *s = opaque;

    s->boot_hold = false;
    keys_update(s);
}

/* "boot" line 0: cold power-on; line 1: woken from deep sleep by a pad. */
static void keys_boot(void *opaque, int n, int level)
{
    X4ClassicKeysState *s = opaque;
    int64_t now = qemu_clock_get_ms(QEMU_CLOCK_VIRTUAL);

    if (!level || !s->power_boot_ms) {
        return;
    }
    if (n == 1 && !s->pressed[KEY_POWER] &&
        (s->power_down_ms < 0 || now - s->power_down_ms > POWER_WAKE_WINDOW_MS)) {
        return;
    }
    s->boot_hold = true;
    timer_mod(&s->boot_timer, now + s->power_boot_ms);
    keys_update(s);
}

/*
 * Every reset ends the previous boot's synthetic Power hold (the keys
 * themselves stay as they are); the RTC's "boot" line starts a new one
 * for a cold power-on or a Power-pad wake. This runs in the enter phase,
 * before any hold phase, so the S3 SoC's reset (a hold phase) and the
 * C3 RTC's (exit phase) can signal the new boot after it.
 */
static void keys_reset_enter(Object *obj, ResetType type)
{
    X4ClassicKeysState *s = X4CLASSIC_KEYS(obj);

    timer_del(&s->boot_timer);
    s->boot_hold = false;
}

static void keys_reset_hold(Object *obj, ResetType type)
{
    /* Physical keys keep their state across a reset; republish the levels. */
    keys_update(X4CLASSIC_KEYS(obj));
}

static void keys_realize(DeviceState *dev, Error **errp)
{
    X4ClassicKeysState *s = X4CLASSIC_KEYS(dev);

    timer_init_ms(&s->boot_timer, QEMU_CLOCK_VIRTUAL, keys_boot_release, s);
    s->input = qemu_input_handler_register(dev, &keys_handler);
    for (int k = 0; k < KEY_COUNT; k++) {
        keys_set(s, k, false);
    }
}

static void keys_unrealize(DeviceState *dev)
{
    X4ClassicKeysState *s = X4CLASSIC_KEYS(dev);

    qemu_input_handler_unregister(s->input);
    timer_del(&s->boot_timer);
}

static void keys_init(Object *obj)
{
    X4ClassicKeysState *s = X4CLASSIC_KEYS(obj);
    qdev_init_gpio_out(DEVICE(obj), s->out, KEY_COUNT);
    qdev_init_gpio_in_named(DEVICE(obj), keys_boot, "boot", 2);
    s->power_down_ms = -1;
    object_property_add_bool(obj, "up", get_up, set_up);
    object_property_add_bool(obj, "down", get_down, set_down);
    object_property_add_bool(obj, "left", get_left, set_left);
    object_property_add_bool(obj, "right", get_right, set_right);
    object_property_add_bool(obj, "confirm", get_confirm, set_confirm);
    object_property_add_bool(obj, "back", get_back, set_back);
    object_property_add_bool(obj, "power", get_power, set_power);
}

static const Property keys_properties[] = {
    DEFINE_PROP_UINT32("power-boot-ms", X4ClassicKeysState, power_boot_ms, 1500),
};

static void keys_class_init(ObjectClass *klass, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);

    dc->realize = keys_realize;
    dc->unrealize = keys_unrealize;
    rc->phases.enter = keys_reset_enter;
    rc->phases.hold = keys_reset_hold;
    device_class_set_props(dc, keys_properties);
}

static const TypeInfo keys_info = {
    .name = TYPE_X4CLASSIC_KEYS,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(X4ClassicKeysState),
    .instance_init = keys_init,
    .class_init = keys_class_init,
};

static void keys_register_types(void)
{
    type_register_static(&keys_info);
}

type_init(keys_register_types)
