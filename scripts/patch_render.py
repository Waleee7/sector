import io

p = r'C:\Users\oluda\sector\src\lib\synth.ts'
s = io.open(p, encoding='utf-8').read()

# --- framing: keep the circle in shot, not clipped to the left edge ---------
old_cam = '''  const midX = (releaseOffset + flight.rangeM) / 2;
  const eye: Vec3 = {
    x: CIRCLE_CENTRE.x + midX * dirX + 6,
    y: CIRCLE_CENTRE.y - 62,
    z: 2.4,
  };
  const target: Vec3 = { x: CIRCLE_CENTRE.x + midX * dirX, y: CIRCLE_CENTRE.y, z: 7 };'''
new_cam = '''  // Frame the whole flight plus a margin behind the circle, so the circle - the
  // thing the calibration depends on - is never clipped to the edge.
  const midX = (releaseOffset + flight.rangeM) / 2;
  const standBack = Math.max(52, flight.rangeM * 0.95);
  const eye: Vec3 = {
    x: CIRCLE_CENTRE.x + (midX - 5) * dirX,
    y: CIRCLE_CENTRE.y - standBack,
    z: 2.4,
  };
  const target: Vec3 = { x: CIRCLE_CENTRE.x + (midX - 5) * dirX, y: CIRCLE_CENTRE.y, z: 6.2 };'''
assert old_cam in s
s = s.replace(old_cam, new_cam)

# --- the render: dusk grading, mown grass, a real concrete circle -----------
old_bg = '''    for (let y = 0; y < H; y++) {
      const sky = y < horizonY;
      const base = sky ? 196 - (y / Math.max(1, horizonY)) * 26 : 96 + ((y - horizonY) / H) * 22;
      for (let x = 0; x < W; x++) buf[y * W + x] = base;
    }'''
new_bg = '''    // Sky: bright at the horizon, deeper overhead, with soft banding so it does
    // not read as one flat slab of grey.
    for (let y = 0; y < horizonY; y++) {
      const f = y / Math.max(1, horizonY);
      const band = Math.sin(f * 7.5) * 3 + Math.sin(f * 2.1 + 1.4) * 5;
      const base = 132 + f * 58 + band;
      for (let x = 0; x < W; x++) buf[y * W + x] = base;
    }
    // Grass: darker than sky, with mowing stripes running downrange. The stripes
    // are static, so the median background model absorbs them completely.
    for (let y = Math.max(0, Math.floor(horizonY)); y < H; y++) {
      const d = (y - horizonY) / Math.max(1, H - horizonY);
      const base = 54 + d * 26;
      for (let x = 0; x < W; x++) {
        const stripe = Math.sin((x / W) * 26 + d * 2.2) > 0 ? 5 : -5;
        buf[y * W + x] = base + stripe * (0.35 + d * 0.65);
      }
    }'''
assert old_bg in s
s = s.replace(old_bg, new_bg)

old_circle = '''    let prevRim: Vec2 | null = null;
    for (let a = 0; a <= 360; a += 6) {
      const rad = (a * Math.PI) / 180;
      const q = project({ x: r * Math.cos(rad), y: r * Math.sin(rad), z: 0 });
      if (prevRim && q) drawLine(buf, W, H, prevRim, q, 240, 1);
      prevRim = q;
    }'''
new_circle = '''    // Distance ticks on the sector lines - a real venue is marked, and they give
    // the eye something to judge scale against.
    for (const sign of [1, -1]) {
      const a = ((CENTRELINE_DEG + sign * SECTOR_HALF_DEG) * Math.PI) / 180;
      for (let d = 10; d <= 70; d += 10) {
        const inner = project({ x: d * Math.cos(a), y: d * Math.sin(a), z: 0 });
        const outer = project({ x: (d + 1.4) * Math.cos(a), y: (d + 1.4) * Math.sin(a), z: 0 });
        if (inner && outer) drawLine(buf, W, H, inner, outer, 214, 1);
      }
    }

    // The circle: a concrete pad with a bright rim, filled from the inside out so
    // the rim stays the brightest thing on the ground.
    for (let rr = r; rr > 0; rr -= 0.12) {
      let prevFill: Vec2 | null = null;
      for (let a = 0; a <= 360; a += 8) {
        const rad = (a * Math.PI) / 180;
        const q = project({ x: rr * Math.cos(rad), y: rr * Math.sin(rad), z: 0 });
        if (prevFill && q) drawLine(buf, W, H, prevFill, q, 126, 1);
        prevFill = q;
      }
    }
    let prevRim: Vec2 | null = null;
    for (let a = 0; a <= 360; a += 4) {
      const rad = (a * Math.PI) / 180;
      const q = project({ x: r * Math.cos(rad), y: r * Math.sin(rad), z: 0 });
      if (prevRim && q) drawLine(buf, W, H, prevRim, q, 236, 1);
      prevRim = q;
    }'''
assert old_circle in s
s = s.replace(old_circle, new_circle)

s = s.replace('        if (prev && q) drawLine(buf, W, H, prev, q, 232, 1);',
              '        if (prev && q) drawLine(buf, W, H, prev, q, 206, 1);')

# Athlete reads darker against the new grading.
s = s.replace('fillEllipse(buf, W, H, stand.x, stand.y, headScale * 0.010, headScale * 0.030, 58);',
              'fillEllipse(buf, W, H, stand.x, stand.y, headScale * 0.010, headScale * 0.030, 30);')
s = s.replace('if (birdX < W - 6) fillEllipse(buf, W, H, birdX, birdY, 3.2, 2.0, 70);',
              'if (birdX < W - 6) fillEllipse(buf, W, H, birdX, birdY, 3.2, 2.0, 86);')
s = s.replace('fillEllipse(buf, W, H, brX, brY, 3.6, 3.0, 74);',
              'fillEllipse(buf, W, H, brX, brY, 3.6, 3.0, 34);')
s = s.replace('fillEllipse(buf, W, H, impPos.x, impPos.y, rx + blur, Math.max(1.1, rx * 0.55), 34);',
              'fillEllipse(buf, W, H, impPos.x, impPos.y, rx + blur, Math.max(1.1, rx * 0.55), 22);')

io.open(p, 'w', encoding='utf-8').write(s)
print("synth.ts restyled")
