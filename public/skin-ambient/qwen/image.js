export async function loadImage(src, signal, image = new Image()) {
  signal.throwIfAborted();
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
