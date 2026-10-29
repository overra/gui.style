// Paints the page the goo rests on, and the button label printed on it. The page canvas is shown as the
// background and also uploaded so the glass can refract the same pixels; the label is a separate mask the
// shader prints onto the page only where it is seen through the goo.

export type Theme = 'light' | 'dark';
/** The page art, or a test art (?art=): `flat` is one solid colour, `bars` black and white bars 32 px wide. */
export type PageArt = 'default' | 'flat' | 'bars';
/** Width of each test bar (CSS px): wider than the blur M3 measures, so every edge reaches full contrast. */
const BAR = 32;

interface Field {
  x: number;
  y: number;
  /** Gaussian-ish radius as a fraction of the viewport's short side. */
  r: number;
  color: string;
  alpha: number;
}

const ART: Record<
  Theme,
  { ground: [string, string]; ink: string; dots: string; grain: number; fields: Field[]; blend: GlobalCompositeOperation }
> = {
  light: {
    ground: ['#f4f2ee', '#efebe4'],
    ink: 'rgba(17, 17, 17, 0.08)',
    dots: 'rgba(17, 17, 17, 0.12)',
    grain: 0.015,
    blend: 'source-over',
    fields: [
      { x: 0.32, y: 0.4, r: 0.55, color: '255, 122, 89', alpha: 0.55 },
      { x: 0.7, y: 0.36, r: 0.5, color: '142, 124, 255', alpha: 0.5 },
      { x: 0.56, y: 0.72, r: 0.55, color: '62, 199, 255', alpha: 0.5 },
    ],
  },
  dark: {
    ground: ['#0b0d12', '#121522'],
    ink: 'rgba(255, 255, 255, 0.07)',
    dots: 'rgba(255, 255, 255, 0.09)',
    grain: 0.02,
    blend: 'lighter',
    fields: [
      { x: 0.33, y: 0.42, r: 0.5, color: '61, 90, 254', alpha: 0.7 },
      { x: 0.7, y: 0.38, r: 0.45, color: '255, 61, 129', alpha: 0.6 },
      { x: 0.55, y: 0.72, r: 0.5, color: '0, 209, 178', alpha: 0.55 },
    ],
  },
};

function grainTile(amount: number): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 128;
  const ctx = tile.getContext('2d');
  if (!ctx) return tile;
  const img = ctx.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = Math.round(Math.random() * amount * 2 * 255);
  }
  ctx.putImageData(img, 0, 0);
  return tile;
}

export function paintPage(
  canvas: HTMLCanvasElement,
  opts: { width: number; height: number; scale: number; theme: Theme; art?: PageArt },
) {
  const { width, height, scale, theme } = opts;
  const art = ART[theme];
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // Test arts are exact and grain-free: the same at every scroll offset (flat), or hard edges to measure (bars).
  if (opts.art === 'flat') {
    ctx.fillStyle = art.ground[0];
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (opts.art === 'bars') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    for (let x = 0; x < width; x += 2 * BAR) ctx.fillRect(x, 0, BAR, height);
    return;
  }

  const ground = ctx.createLinearGradient(0, 0, 0, height);
  ground.addColorStop(0, art.ground[0]);
  ground.addColorStop(1, art.ground[1]);
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);

  // Large soft colour fields; their boundaries cross the button so the lensing has something to bend.
  const short = Math.min(width, height);
  ctx.globalCompositeOperation = art.blend;
  for (const f of art.fields) {
    const cx = f.x * width;
    const cy = f.y * height;
    const r = f.r * short;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(${f.color}, ${f.alpha})`);
    g.addColorStop(0.35, `rgba(${f.color}, ${f.alpha * 0.72})`);
    g.addColorStop(0.7, `rgba(${f.color}, ${f.alpha * 0.25})`);
    g.addColorStop(1, `rgba(${f.color}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.globalCompositeOperation = 'source-over';

  // Hairlines tilted ~12° (lines parallel to the button edges would hide the bending) and a sparse dot grid.
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((12 * Math.PI) / 180);
  const reach = Math.hypot(width, height) / 2 + 24;
  ctx.strokeStyle = art.ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -reach; x <= reach; x += 24) {
    ctx.moveTo(x, -reach);
    ctx.lineTo(x, reach);
  }
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = art.dots;
  ctx.beginPath();
  for (let y = 8; y < height; y += 16) {
    for (let x = 8; x < width; x += 16) {
      ctx.moveTo(x + 1.1, y);
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
    }
  }
  ctx.fill();

  // Fine grain kills banding in the gradients.
  const pattern = ctx.createPattern(grainTile(art.grain), 'repeat');
  if (pattern) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

/**
 * The label as a two-channel mask over the label box: red = a soft dimming plate that keeps the text legible
 * over any colour field, green = the text itself. Colours are applied in the shader.
 */
export function paintLabel(
  canvas: HTMLCanvasElement,
  opts: { width: number; height: number; scale: number; text: string; font: string },
) {
  const { width, height, scale, text, font } = opts;
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(text);
  const textW = Math.min(m.width, width - 24);
  const ascent = m.actualBoundingBoxAscent;
  const descent = m.actualBoundingBoxDescent;

  // Plate: a rounded rect around the text, blurred.
  const plateW = textW + 44;
  const plateH = ascent + descent + 26;
  ctx.save();
  if ('filter' in ctx) ctx.filter = `blur(${8 * scale}px)`;
  ctx.fillStyle = '#f00';
  ctx.beginPath();
  ctx.roundRect((width - plateW) / 2, (height - plateH) / 2, plateW, plateH, plateH / 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#0f0';
  ctx.fillText(text, width / 2, height / 2 + (ascent - descent) / 2, width - 24);
}
