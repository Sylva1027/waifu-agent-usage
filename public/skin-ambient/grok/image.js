export async function loadImage(src, signal) {
  signal.throwIfAborted();
  const image = new Image();
  const release = () => image.removeAttribute("src");
  signal.addEventListener("abort", release, { once: true });
  try {
    image.src = src;
    await image.decode();
    signal.throwIfAborted();
    return image;
  } finally {
    signal.removeEventListener("abort", release);
  }
}
