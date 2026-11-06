# A device Home Assistant does not have yet

`ha.py find` cannot find what HA does not control. That does not end the question; this page starts there.
Live, asked "what's my room temperature?" and then "I have a Xiaomi air purifier", an agent swept the network, tried
three addresses and gave up asking the person to read IPs out of an app. The order below gets there with one question.

## 1. Find out what it is, in one question

Ask once, in one message: **the brand and model** (the label underneath, or the maker's app → the device → settings →
device info), **the app they control it with** (Mi Home / Xiaomi Home, Smart Life / Tuya, Tapo, eWeLink, ThinQ …), and
**whether they have Home Assistant**. A reading they ask about (a room's temperature, humidity, air quality) comes
from a device that measures it: an air purifier, an air conditioner, a thermometer, a Zigbee sensor. Ask which one is
in that room.

## 2. Find it on the network

The `network-reach` skill sweeps the network. To tell which address is the device, three things beat guessing:

| Look at | What gives it away |
|---|---|
| mDNS (`avahi-browse -atrp`, `dns-sd -B` on a Mac) | the service it announces: `_miio._udp` Xiaomi Wi-Fi devices (the name carries the model: `zhimi-airp-…_miio…`), `_hap._tcp` HomeKit, `_matterc._udp` / `_matter._tcp` Matter, `_esphomelib._tcp` ESPHome, `_googlecast._tcp` Chromecast and Google TVs, `_hue._tcp` a Hue bridge, `_shelly._tcp` Shelly |
| the router's list of clients | the hostname the device asked for (`zhimi-…`, `tapo-…`, `ESP_…`) beside its address |
| the neighbour table's MAC address | its maker, from the first half of the address. Many cheap Wi-Fi devices show the chip's maker (Espressif) rather than the brand |

**No answer from any address is not "local control is off".** A device on a guest or "IoT" Wi-Fi is usually kept
from talking to the rest of the network, and an address read from an old list may have changed. Say which of these
it could be, and ask. Do not conclude the device cannot be reached.

## 3. Bring it into Home Assistant (the usual way)

When they have HA, this is almost always the answer: add the device's integration once, and from then on everything in
SKILL.md works on it. The person does it in HA: **Settings → Devices & services → Add integration**, search the name.

| The app they use | The integration to add | What it asks for |
|---|---|---|
| Xiaomi Home / Mi Home | **Xiaomi Home** (Xiaomi's own, added to HACS as the custom repository `github.com/XiaoMi/ha_xiaomi_home`), or the built-in **Xiaomi Miio** | a sign-in to their Xiaomi account in HA's own window, and the account's region; Xiaomi Miio takes the device's address and token instead |
| Smart Life / Tuya | **Tuya** | a QR code scanned with the Smart Life app |
| Tapo, Kasa | **TP-Link Smart Home** | the TP-Link account, for Tapo |
| Philips Hue | **Philips Hue** | a press of the bridge's button |
| eWeLink, Sonoff | **Sonoff** (SonoffLAN, through HACS) | the eWeLink account |
| LG ThinQ | **LG ThinQ** | a personal access token from LG's developer site |
| a Matter device | **Matter** | the pairing code on the device or its box |
| a HomeKit-only device | **HomeKit Device** | the pairing code, after removing it from Apple Home |
| a Zigbee sensor or switch | **ZHA**, or Zigbee2MQTT | a Zigbee USB stick on the HA machine |
| ESPHome | **ESPHome** | nothing: it is found by itself |
| Chromecast, Google TV | **Google Cast** | nothing: it is found by itself |
| an IR-only AC or TV | **Broadlink** with **SmartIR** | an IR blaster; its state is HA's guess of the last command |

Logins to vendor accounts happen in HA's own window, typed by the person; **never ask for their account password in the
chat.** After it is added, `ha.py find <name>` finds the device; go on with SKILL.md.

## 4. Without Home Assistant

Only when they have no HA and do not want one. Every route below needs the device's own key, which only the person can
get, and works only on the same network as the device.

| Device | Library | Its key |
|---|---|---|
| Xiaomi Wi-Fi (purifiers, fans, vacuums, lamps) | `python-miio`: `miiocli discover`, then `miiocli device --ip IP --token "$MIIO_TOKEN" info`; newer purifiers `miiocli airpurifiermiot --ip IP --token "$MIIO_TOKEN" status` (some models answer it empty; `info` names the model to look up) | a 32-character token from the Xiaomi cloud: the person runs *Xiaomi Cloud Tokens Extractor* on their own computer, with their own login |
| Tuya / Smart Life | `tinytuya`: `python3 -m tinytuya scan` finds them | a local key, through a free Tuya developer account (`python3 -m tinytuya wizard`) |
| TP-Link Kasa, Tapo | `python-kasa`: `kasa discover`, `kasa --host IP state` | none for Kasa; the TP-Link login for Tapo |
| Hue | the bridge's own REST API | a user created by pressing the bridge's button |

`pip install` the library in your own Python env (your TOOLS section says who approves an install). If it will not
install on this Python, say so: Home Assistant (§3) is then the way. The key the person sends is a secret like the HA
token: `/secret set miio_token <token>`, then `$MIIO_TOKEN` in your commands, never in a file, a note or a reply.

Reading and switching this way is fine; for anything that runs by itself (an automation, a schedule), HA is the place.
