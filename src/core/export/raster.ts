/** Browser-only helpers that turn the diagram SVG into raster images. */

function svgSize(svg: string): { width: number; height: number } {
  const match = svg.match(/<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/);
  return { width: match ? Number(match[1]) : 800, height: match ? Number(match[2]) : 600 };
}

/**
 * Rasterises an SVG string to PNG. The scale is reduced automatically for
 * very large diagrams so the canvas stays within what browsers can allocate.
 */
export async function svgToPng(svg: string, scale = 2): Promise<{ blob: Blob; width: number; height: number }> {
  const { width, height } = svgSize(svg);
  const maxSide = 14_000;
  const maxArea = 80_000_000;
  const factor = Math.min(scale, maxSide / width, maxSide / height, Math.sqrt(maxArea / (width * height)));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The diagram could not be rendered as an image.'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * factor));
    canvas.height = Math.max(1, Math.round(height * factor));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The diagram could not be rendered as an image.');
    return { blob, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}
