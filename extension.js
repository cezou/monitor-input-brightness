// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Used when a monitor's capabilities string doesn't list its inputs.
const FALLBACK_INPUTS = [
    [0x0f, 'DisplayPort-1'],
    [0x11, 'HDMI-1'],
    [0x12, 'HDMI-2'],
];

async function ddcutil(args) {
    const proc = Gio.Subprocess.new(
        ['ddcutil', ...args],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
    if (!proc.get_successful())
        throw new Error(`ddcutil ${args.join(' ')}: ${stderr.trim()}`);
    return stdout;
}

// ddcutil must not talk to the same I2C bus concurrently, so commands are
// chained per bus.
const busQueues = new Map();
function onBus(bus, args) {
    const prev = busQueues.get(bus) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => ddcutil(['--bus', String(bus), ...args]));
    busQueues.set(bus, next);
    return next;
}

function parseDetect(out) {
    const displays = [];
    let cur = null;
    for (const line of out.split('\n')) {
        let m;
        if (/^Display \d+/.test(line)) {
            cur = {};
            displays.push(cur);
        } else if (!cur) {
            continue;
        } else if ((m = line.match(/I2C bus:\s+\/dev\/i2c-(\d+)/))) {
            cur.bus = Number(m[1]);
        } else if ((m = line.match(/DRM connector:\s+card\d+-(\S+)/))) {
            cur.connector = m[1];
        } else if ((m = line.match(/Monitor:\s+[^:]*:([^:]*):/))) {
            cur.model = m[1];
        }
    }
    return displays.filter(d => d.bus !== undefined);
}

function parseInputs(caps) {
    const inputs = [];
    let inFeature = false;
    for (const line of caps.split('\n')) {
        if (/Feature:/.test(line)) {
            inFeature = /Feature:\s+60\b/.test(line);
            continue;
        }
        const m = inFeature && line.match(/^\s+([0-9a-fA-F]{2}):\s+(.+)$/);
        if (m)
            inputs.push([parseInt(m[1], 16), m[2].trim()]);
    }
    return inputs.length ? inputs : FALLBACK_INPUTS;
}

// "VCP 10 C 80 100" / "VCP 60 SNC x11"
function parseVcp(out) {
    const values = {};
    for (const line of out.split('\n')) {
        let m;
        if ((m = line.match(/^VCP 10 C (\d+) (\d+)/)))
            values.brightness = Number(m[1]) / Number(m[2]);
        else if ((m = line.match(/^VCP 60 SNC x([0-9a-fA-F]+)/)))
            values.input = parseInt(m[1], 16);
    }
    return values;
}

class MonitorSection {
    constructor(menu, display) {
        this.display = display;
        this._debounceId = 0;
        this._settingSlider = false;

        const label = `${display.model ?? 'Monitor'} — ${display.connector ?? `i2c-${display.bus}`}`;
        this.section = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(label));

        const sliderItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        sliderItem.add_child(new St.Icon({
            icon_name: 'display-brightness-symbolic',
            style_class: 'popup-menu-icon',
        }));
        this.slider = new Slider.Slider(0);
        this.slider.x_expand = true;
        this.slider.connect('notify::value', () => this._onSliderChanged());
        sliderItem.add_child(this.slider);
        this.section.addMenuItem(sliderItem);

        this.inputItems = new Map();
        for (const [code, name] of display.inputs) {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => this._setInput(code));
            this.inputItems.set(code, item);
            this.section.addMenuItem(item);
        }

        menu.addMenuItem(this.section);
    }

    async refresh() {
        try {
            const values = parseVcp(await onBus(this.display.bus, ['getvcp', '10', '60', '--brief']));
            if (values.brightness !== undefined) {
                this._settingSlider = true;
                this.slider.value = values.brightness;
                this._settingSlider = false;
            }
            this._markInput(values.input);
        } catch (e) {
            console.warn(`[monitor-input-brightness] ${e.message}`);
        }
    }

    _markInput(current) {
        for (const [code, item] of this.inputItems) {
            item.setOrnament(code === current
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
    }

    _onSliderChanged() {
        if (this._settingSlider)
            return;
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._debounceId = 0;
            const value = String(Math.round(this.slider.value * 100));
            onBus(this.display.bus, ['setvcp', '10', value, '--noverify'])
                .catch(e => console.warn(`[monitor-input-brightness] ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _setInput(code) {
        try {
            await onBus(this.display.bus, ['setvcp', '60', `0x${code.toString(16)}`, '--noverify']);
            this._markInput(code);
        } catch (e) {
            Main.notifyError('Input switch failed', e.message);
        }
    }

    destroy() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this.section.destroy();
    }
}

const MonitorIndicator = GObject.registerClass(
class MonitorIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Monitor Input & Brightness');
        this.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        }));

        this._monitors = [];
        this._monitorsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._monitorsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Re-detect monitors', () => this._detect());
        this.menu.addAction('Open ddcui', () => {
            try {
                Gio.Subprocess.new(['ddcui'], Gio.SubprocessFlags.NONE);
            } catch {
                Main.notifyError('ddcui not found', 'Install the ddcui package.');
            }
        });

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._monitors.forEach(m => m.refresh());
        });

        this._detect();
    }

    async _detect() {
        this._monitors.forEach(m => m.destroy());
        this._monitors = [];
        this._monitorsSection.removeAll();
        const status = new PopupMenu.PopupMenuItem('Detecting monitors…', {reactive: false});
        this._monitorsSection.addMenuItem(status);

        try {
            const displays = parseDetect(await ddcutil(['detect', '--brief']));
            for (const d of displays) {
                try {
                    d.inputs = parseInputs(await onBus(d.bus, ['capabilities']));
                } catch {
                    d.inputs = FALLBACK_INPUTS;
                }
            }
            status.destroy();
            if (!displays.length)
                this._monitorsSection.addMenuItem(
                    new PopupMenu.PopupMenuItem('No DDC/CI monitor found', {reactive: false}));
            for (const d of displays)
                this._monitors.push(new MonitorSection(this._monitorsSection, d));
            if (this.menu.isOpen)
                this._monitors.forEach(m => m.refresh());
        } catch (e) {
            status.label.text = 'ddcutil failed';
            console.warn(`[monitor-input-brightness] ${e.message}`);
        }
    }

    destroy() {
        this._monitors.forEach(m => m.destroy());
        this._monitors = [];
        super.destroy();
    }
});

export default class MonitorInputBrightnessExtension extends Extension {
    enable() {
        this._indicator = new MonitorIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
