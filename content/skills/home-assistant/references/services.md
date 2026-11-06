# Home Assistant services, by kind of device

Field lists checked against Home Assistant 2026.2. Your HA may be newer: `python3 HA services DOMAIN` prints the
fields *that* instance takes, and `python3 HA state ENTITY --all` prints what *that* device supports. Trust those
over this page.

Every example is `python3 HA call SERVICE ENTITY field=value ...`. Before you set a mode, a preset, a source or a
speed, read the entity's list for it (`state` shows it). The helper refuses a value the entity does not list and
corrects one that differs only in upper/lower case, because HA itself answers a wrong value with a bare `500`.

## light

| Want | Call |
|---|---|
| on / off / toggle | `light.turn_on` · `light.turn_off` · `light.toggle` |
| brightness | `light.turn_on light.x brightness_pct=40` (0–100). `brightness=` is 0–255; prefer `_pct` |
| brighter / dimmer by a step | `light.turn_on light.x brightness_step_pct=20` (or `-20`) |
| warm / cool white | `light.turn_on light.x color_temp_kelvin=2700` (warm) … `6500` (daylight), within `min_color_temp_kelvin`..`max_color_temp_kelvin` |
| a colour | `rgb_color=[255,0,0]`, or `color_name=red` (CSS names: red, blue, green, orange, purple, pink, white, …), or `hs_color=[30,100]` |
| fade | add `transition=5` (seconds), on lights that support it |
| an effect | `effect=colorloop`, a value from `effect_list` |
| off after a while | not a light field. Use a script with a delay, or tell the person; never sleep in your own turn for minutes |

What a light can do is in `supported_color_modes`: `onoff` (only on/off), `brightness`, `color_temp`, `hs`/`xy`/`rgb`/
`rgbw`/`rgbww` (colour). Asking a `color_temp`-only bulb for red does nothing useful, so say it cannot do colours.
A light that is off has `brightness: null`; that is not an error.

`light.turn_off` takes only `transition` and `flash`. A Zigbee group or an HA light group is one entity that switches
many bulbs; `state --all` shows its members in `entity_id`.

## switch, input_boolean, plug

`switch.turn_on` · `switch.turn_off` · `switch.toggle`. A smart plug is a `switch`; its power draw is a separate
`sensor.*_power` (W) and energy `sensor.*_energy` (kWh). Find them with `find <plug name> power`.
A plug feeding a fridge, freezer, aquarium pump, router or server: ask before turning it off.

## climate (air conditioners, heat pumps, thermostats)

| Want | Call |
|---|---|
| cool to 24 °C | `climate.set_temperature climate.ac temperature=24 hvac_mode=cool` |
| a range (heat_cool / auto thermostats) | `climate.set_temperature climate.x target_temp_low=20 target_temp_high=25` |
| mode | `climate.set_hvac_mode climate.ac hvac_mode=cool` (from `hvac_modes`: `off`, `heat`, `cool`, `heat_cool`, `auto`, `dry`, `fan_only`) |
| off / on | `climate.turn_off` · `climate.turn_on` (back to the last mode), or `hvac_mode=off` |
| fan speed | `climate.set_fan_mode climate.ac fan_mode=low` (from `fan_modes`) |
| swing | `climate.set_swing_mode climate.ac swing_mode=on` (from `swing_modes`) |
| eco / sleep / boost | `climate.set_preset_mode climate.ac preset_mode=eco` (from `preset_modes`) |
| humidity target | `climate.set_humidity climate.x humidity=50` (only where `min_humidity`/`max_humidity` exist) |

`current_temperature` is the room, `temperature` is the target. `hvac_action` (`cooling`, `idle`, `off`) is what it is
doing now, when the device reports it. `target_temp_step` says whether 24.5 is allowed. An AC that is `off` often
ignores a temperature alone: send `hvac_mode` in the same call. Many ACs are reached by infrared (Broadlink, SmartIR,
Tuya IR hubs): HA only remembers the last command it sent, so "is the AC on?" answered from `state` is HA's belief;
say so if it matters.

## fan (ceiling fans, standing fans, and most air purifiers)

| Want | Call |
|---|---|
| on at a speed | `fan.turn_on fan.x percentage=50` |
| speed | `fan.set_percentage fan.x percentage=33` (`percentage_step` says the steps: 33.3 on a 3-speed fan) |
| one step faster / slower | `fan.increase_speed fan.x` · `fan.decrease_speed fan.x` |
| a mode | `fan.set_preset_mode fan.x preset_mode=Auto` (from `preset_modes`) |
| oscillate | `fan.oscillate fan.x oscillating=true` |
| direction | `fan.set_direction fan.x direction=reverse` (`forward` / `reverse`) |

**Air purifiers** (Xiaomi/Mi, Levoit, Philips, Blueair, Coway, …) are usually a `fan` entity whose `preset_modes`
hold the purifier modes: `Auto`, `Sleep`, `Favorite`, `Silent`, `Manual`, often capitalised. Some newer integrations
add an `air_purifier`-style `fan` with only presets and no `percentage`. Around the fan entity there are usually
separate entities for the rest. Find them with the device's name:

| Thing | Usually |
|---|---|
| PM2.5 | `sensor.<name>_pm2_5` (µg/m³), device_class `pm25` |
| filter life left | `sensor.<name>_filter_life_remaining` (%) |
| LED / display, child lock, buzzer | `switch.<name>_led`, `switch.<name>_child_lock`, `switch.<name>_buzzer` |
| brightness of the display, favorite level | `select.*` or `number.*`: `select.select_option option=…`, `number.set_value value=…` |

A humidifier is the `humidifier` domain: `humidifier.set_humidity humidity=55`, `humidifier.set_mode mode=…` (from
`available_modes`), `humidifier.turn_on/turn_off`.

## vacuum (robot vacuums)

| Want | Call |
|---|---|
| start / pause / stop | `vacuum.start` · `vacuum.pause` · `vacuum.stop` |
| send it home | `vacuum.return_to_base` |
| find it (it beeps) | `vacuum.locate` |
| suction | `vacuum.set_fan_speed vacuum.x fan_speed=turbo` (from `fan_speed_list`) |
| one room or zone | `vacuum.send_command` with the maker's own command (below) |

States: `cleaning`, `docked`, `returning`, `paused`, `idle`, `error`. `battery_level` and `status` (when present)
say more. Room cleaning has no common service; it is each maker's command, and the room ids come from the vacuum's
own map:

- Roborock / Xiaomi (official Roborock integration): `vacuum.send_command vacuum.x command=app_segment_clean
  params=[16,17]` (room ids; the integration also offers `roborock.get_maps` with `--response` to list them).
- Valetudo (local firmware): through its MQTT entities or its own buttons/selects per room.
- Others: look at `services <integration domain>` and the integration's documentation before trying; a wrong command
  usually does nothing silently.

If the person names a room you cannot map to an id, say so and offer a whole-house clean instead.

## cover (curtains, blinds, shutters, garage doors, gates)

| Want | Call |
|---|---|
| open / close / stop | `cover.open_cover` · `cover.close_cover` · `cover.stop_cover` |
| half way | `cover.set_cover_position cover.x position=50` (0 = closed, 100 = open) |
| slats | `cover.set_cover_tilt_position cover.x tilt_position=30` |

`device_class` says what it is: `curtain`, `blind`, `shade`, `shutter`, `awning`, `window`, `garage`, `gate`, `door`.
Opening a `garage`, `gate` or `door` cover asks the person first (the helper refuses until `--confirmed`). Closing one
is fine when asked, but a garage door closing on a car or a person is the reason some integrations refuse remote
close; if it refuses, say so. States move through `opening`/`closing` for up to a minute.

## media_player (TVs, speakers, Chromecast, Sonos, Spotify)

| Want | Call |
|---|---|
| on / off | `media_player.turn_on` · `media_player.turn_off` (many TVs cannot be turned *on* over the network unless Wake-on-LAN or a CEC device is set up) |
| play / pause / next | `media_player.media_play` · `media_pause` · `media_play_pause` · `media_next_track` · `media_previous_track` |
| volume | `media_player.volume_set media_player.x volume_level=0.3` (0–1) · `volume_up` · `volume_down` · `volume_mute is_volume_muted=true` |
| input / app | `media_player.select_source media_player.tv source=HDMI 1` (from `source_list`) |
| play a URL or item | `media_player.play_media media_player.x media_content_id=https://…/a.mp3 media_content_type=music` (newer HA also takes `media={"media_content_id":…,"media_content_type":…}`) |
| say something on a speaker | `tts.speak` with `media_player_entity_id=media_player.x message="…"` and the TTS entity as target, e.g. `call tts.speak tts.<engine> media_player_entity_id=media_player.kitchen message="Makan malam siap"`; the TTS entity id comes from `find --domain tts` |
| search the library | `media_player.search_media media_player.x search_query=Beatles --response` |

`media_title`, `media_artist`, `app_name`, `source` say what is playing.

## scene, script, automation, button

- `scene.turn_on scene.x`: a scene's state is the time it was last activated, not on/off.
- `script.turn_on script.x` (runs it in the background), or `call script.x` with no entity to wait for it. A
  script's state is `on` while it runs. Read what a script does before running an unfamiliar one:
  `config script script.x`.
- `automation.trigger automation.x` runs its actions now (skips its conditions unless `skip_condition=false`).
  `automation.turn_off` disables it until turned on again, so ask first.
- `button.press button.x`: ask first unless the person named that button (buttons restart, reboot, identify, ring).

## lock, alarm, siren

`lock.lock` is fine when asked. `lock.unlock` / `lock.open` and `alarm_control_panel.alarm_disarm` need the person's
yes in this conversation, then `--confirmed`. Some take `code=`. The person's alarm code is a secret like a password:
it goes through the secret store, never in a reply. Arming (`alarm_arm_away`, `alarm_arm_home`, `alarm_arm_night`) is
fine when asked. `siren.turn_on` makes noise for the neighbours, so ask.

## notify (a message to a phone or a screen)

`notify.mobile_app_<phone>` sends a push to the HA Companion app on that phone: `call notify.mobile_app_budi_phone
message="Pintu garasi masih terbuka" title="Rumah"`. `services notify` lists the phones. Add `data={"priority":"high"}`
on Android to get it through Do Not Disturb, only when it is urgent. `notify.persistent_notification message=…`
shows a notification in HA's own sidebar.

## sensors and binary sensors

Read only. `state` gives the value and `unit_of_measurement`; `device_class` names what it measures
(`temperature`, `humidity`, `pm25`, `co2`, `power`, `energy`, `battery`, `illuminance`, `motion`, `door`, `window`,
`occupancy`, `moisture` …). A `binary_sensor` is `on`/`off`: for a door `on` means open, for motion `on` means
motion, for moisture `on` means wet. Say it in words ("pintu depan terbuka sejak 14:02"), never "binary_sensor is on".

## weather, sun, person, zone

- `call weather.get_forecasts weather.home type=daily --response` (or `hourly`, `twice_daily`). The state alone is
  only the current condition.
- `sun.sun`: `state` is `above_horizon`/`below_horizon`; `sensor.sun_next_rising` etc. when enabled.
- `person.budi`: `home`, `not_home` or a zone name. Where someone is is theirs, so answer the owner, not anyone who
  asks.

## select, number, input_*

`select.select_option select.x option=…` (from `options`), `number.set_value number.x value=42` (within `min`..`max`,
in `step`s), `input_number.set_value`, `input_select.select_option`, `input_text.set_value`,
`input_datetime.set_datetime`. These are often settings of a device (a purifier's display brightness, a vacuum's
mop intensity) or helpers the person's automations read.
