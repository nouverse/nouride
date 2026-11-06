# Assets: asking, finding, checking, cutting

What goes into the video that the code does not draw: a logo, photos, screenshots, footage, music, fonts. Read this
before the storyboard, and do it in this order.

## 1. Ask the person first

Before you look for anything, ask, in one message beside the storyboard:

- **Their own assets.** A logo (SVG or a large PNG), product screenshots, photos, footage, a brand font and colours.
  Theirs always beat anything found: ask where they are, or ask them to send them.
- **Music.** None, theirs, or one you find. Say that found music needs a licence that allows it, and usually a credit.
- **What not to use.** A competitor's logo, a face, a page they do not want shown.

Only when they say "find it yourself", or have nothing, go to §2. Write each asset in the storyboard with where it
comes from: `logo: theirs, /path/logo.svg`, `music: "Chill Wave", Kevin MacLeod, CC BY 4.0`.

## 2. Find it, only where the licence is stated

| What | Where | Licence to check |
|---|---|---|
| Screenshots of a site or app | Take them yourself with the `browser-automation` skill, from the real page | Theirs, or a public page they asked for |
| Photos, footage | Unsplash, Pexels, Pixabay; Wikimedia Commons per file | The site's own licence page; Commons: the file's own licence |
| Icons | Lucide (ISC), Heroicons (MIT), Tabler Icons (MIT) | The repository's licence file |
| Brand logos | The brand's own press kit or site, never redrawn or recoloured | The brand's usage rules |
| Fonts | Google Fonts, through `@remotion/google-fonts` | OFL or Apache, on the font's page |
| Music | incompetech (Kevin MacLeod, CC BY 4.0), Pixabay Music, Free Music Archive per track | The track's own page; CC BY needs a credit on screen |

A file whose licence you cannot find is not used. Download the file itself, not the page, and check you got it:

```sh
mkdir -p assets-src && cd assets-src
curl -fsSL --max-time 120 -o photo.jpg "<direct file URL>" && file photo.jpg
```

`file` must say an image, video or audio type. An HTML page means the link was a page, not the file.

Write every found asset into `CREDITS.md` in the project, one line each: file, source URL, author, licence. A CC BY
asset also gets its credit in the video's last scene.

## 3. Cut it to size with the FFmpeg Remotion bundles

Originals stay in `assets-src/`; what the video uses goes to `public/`, named in lowercase with dashes. Every command
below runs in the project folder with nothing to install. Run one, then look at the result (§4) before the next.

```sh
F="npx remotion ffmpeg -v error -y"

# Images
$F -i assets-src/shot.png -vf "crop=1200:675:100:80" public/shot-crop.png      # crop: width:height:x:y
$F -i assets-src/photo.jpg -vf "scale=1920:-2" public/photo.png               # resize to 1920 wide
$F -i assets-src/photo.jpg -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" public/bg.png   # fill 16:9
$F -i assets-src/photo.jpg -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" public/bg-vertical.png   # fill 9:16
$F -i assets-src/icon.webp public/icon.png                                    # convert

# Video
$F -ss 5 -t 4 -i assets-src/clip.mp4 -an -c:v libx264 -pix_fmt yuv420p public/clip.mp4   # 4 s from 0:05, no sound
$F -i public/clip.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -c:v libx264 -pix_fmt yuv420p public/clip-vertical.mp4

# Audio
$F -ss 2 -t 20 -i assets-src/track.mp3 -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a libmp3lame public/music.mp3   # 20 s from 0:02, even loudness
$F -i assets-src/footage.mp4 -vn -c:a libmp3lame public/voice.mp3             # the sound of a video
```

This FFmpeg has no `afade`, and cannot write `.m4a`: fade music in the code, where the frame decides it, and write
audio as `.mp3`.

```tsx
<Audio src={staticFile("music.mp3")} volume={(f) => interpolate(f, [0, fps, durationInFrames - 2 * fps, durationInFrames], [0, 0.25, 0.25, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
```

A screenshot is cropped to what the scene is about (the part of the page the line on screen talks about), not shown
whole and small. Find the coordinates by `read`ing the screenshot first.

## 4. Look at every asset before it goes in

- An image: `read` it after every cut to see the crop is where you meant, nothing is cut off, it is not blurred from
  being made bigger. Something smaller than the size it will fill is upscaled and blurs: find a bigger one.
- Video and audio: what they are, as numbers.

```sh
npx remotion ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of compact=p=0:nk=1 public/clip.mp4
```

It prints the codec, the size and the duration (`h264|1920|1080 4.000000`). A duration of 0 or no line at all means
the file is not what its name says.
