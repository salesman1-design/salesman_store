// music-player.js

const playlist = [
  'https://files.catbox.moe/u5e4te.mp3',
  'https://files.catbox.moe/rpu9ir.mp3',
  'https://files.catbox.moe/6z47pi.mp3'
];

let currentTrack = 0;
const audio = new Audio();
audio.src = playlist[currentTrack];
audio.loop = false;
audio.volume = 0.4;
audio.autoplay = true;
audio.play().catch(() => {
  // Browser requires user interaction, so we’ll wait
});

audio.addEventListener('ended', () => {
  currentTrack = (currentTrack + 1) % playlist.length;
  audio.src = playlist[currentTrack];
  audio.play();
});
