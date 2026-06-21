/**
 * Premium Background Engine Core
 * Analyzes an image via Canvas to extract colors and assess readability.
 */

export interface BackgroundProfile {
  cssVars: Record<string, string>;
  colors: {
    primary: string;
    secondary: string;
    surfaceTint: string;
  };
  luminance: number;
}

// Convert RGB to HSL for saturation checking
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r, g, b;
  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
}

export async function processBackground(imageUrl: string): Promise<BackgroundProfile> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    
    img.onload = () => {
      const canvas = document.createElement("canvas");
      // Scale down for faster processing while retaining enough data
      const MAX_DIM = 250;
      let width = img.width;
      let height = img.height;
      if (width > height) {
        if (width > MAX_DIM) { height *= MAX_DIM / width; width = MAX_DIM; }
      } else {
        if (height > MAX_DIM) { width *= MAX_DIM / height; height = MAX_DIM; }
      }
      
      canvas.width = Math.max(1, Math.floor(width));
      canvas.height = Math.max(1, Math.floor(height));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("No 2d context"));
      
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      if (typeof Worker !== "undefined") {
        const workerCode = `
          function rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h = 0, s = 0, l = (max + min) / 2;

            if (max !== min) {
              const d = max - min;
              s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
              switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
              }
              h /= 6;
            }
            return [h, s, l];
          }

          function hslToRgb(h, s, l) {
            let r, g, b;
            if (s === 0) {
              r = g = b = l; // achromatic
            } else {
              const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
              };
              const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
              const p = 2 * l - q;
              r = hue2rgb(p, q, h + 1/3);
              g = hue2rgb(p, q, h);
              b = hue2rgb(p, q, h - 1/3);
            }
            return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
          }

          function rgbToHex(r, g, b) {
            return "#" + [r, g, b].map(x => {
              const hex = x.toString(16);
              return hex.length === 1 ? "0" + hex : hex;
            }).join("");
          }

          self.onmessage = function(e) {
            try {
              const { buffer, width, height } = e.data;
              const data = new Uint8ClampedArray(buffer);
              
              let totalLuminance = 0;
              let rSum = 0, gSum = 0, bSum = 0;
              
              // To find vibrant colors, we keep track of the highest saturation pixels
              let maxSat1 = -1;
              let vibrant1 = [0, 0, 0];
              
              let maxSat2 = -1;
              let vibrant2 = [0, 0, 0];
              
              const pixelCount = data.length / 4;
              const luminances = new Float32Array(pixelCount);
              
              for (let i = 0, p = 0; i < data.length; i += 4, p++) {
                const r = data[i];
                const g = data[i+1];
                const b = data[i+2];
                
                rSum += r; gSum += g; bSum += b;
                
                // Luminance calculation
                const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                totalLuminance += lum;
                luminances[p] = lum;
                
                const [h, s, l] = rgbToHsl(r, g, b);
                
                // We want vibrant colors (high saturation, medium luminance)
                if (l > 0.2 && l < 0.8) {
                  // Score based on saturation and slightly on luminance
                  const score = s * (1 - Math.abs(l - 0.5));
                  if (score > maxSat1) {
                    // Push old vibrant1 to vibrant2 if hue is sufficiently different
                    const oldH = rgbToHsl(vibrant1[0], vibrant1[1], vibrant1[2])[0];
                    const hueDiff = Math.min(Math.abs(h - oldH), 1 - Math.abs(h - oldH));
                    if (hueDiff > 0.1) {
                      maxSat2 = maxSat1;
                      vibrant2 = [vibrant1[0], vibrant1[1], vibrant1[2]];
                    }
                    maxSat1 = score;
                    vibrant1 = [r, g, b];
                  } else if (score > maxSat2) {
                    const h1 = rgbToHsl(vibrant1[0], vibrant1[1], vibrant1[2])[0];
                    const hueDiff = Math.min(Math.abs(h - h1), 1 - Math.abs(h - h1));
                    // Only accept if hue is reasonably different from vibrant1
                    if (hueDiff > 0.1) {
                      maxSat2 = score;
                      vibrant2 = [r, g, b];
                    }
                  }
                }
              }
              
              const avgLuminance = totalLuminance / pixelCount;
              
              // Calculate variance (busyness)
              let varianceSum = 0;
              for (let i = 0; i < pixelCount; i++) {
                const diff = luminances[i] - avgLuminance;
                varianceSum += diff * diff;
              }
              const variance = varianceSum / pixelCount;
              // standard deviation is Math.sqrt(variance), typically 0 to 0.5
              const stdDev = Math.sqrt(variance);
              
              // Extract Palette
              const avgColor = [Math.round(rSum / pixelCount), Math.round(gSum / pixelCount), Math.round(bSum / pixelCount)];
              
              // Fallbacks if image is totally desaturated
              if (maxSat1 < 0.1) vibrant1 = avgColor;
              if (maxSat2 < 0.1) vibrant2 = vibrant1;
              
              // Surface tint is a deeply darkened version of the average color to fit the dark theme
              const [avgH, avgS] = rgbToHsl(avgColor[0], avgColor[1], avgColor[2]);
              const surfaceRgb = hslToRgb(avgH, avgS * 0.5, 0.12); // Very dark tint
              
              const primary = rgbToHex(vibrant1[0], vibrant1[1], vibrant1[2]);
              const secondary = rgbToHex(vibrant2[0], vibrant2[1], vibrant2[2]);
              const surfaceTint = rgbToHex(surfaceRgb[0], surfaceRgb[1], surfaceRgb[2]);
              
              // Readability Engine Adjustments
              // Average luminance is 0 to 1.
              // If > 0.5, image is quite bright. We need strong dark overlays to read white text.
              // If stdDev is high (> 0.2), image is busy. We need higher blur.
              
              let baseBlur = 12; // default
              if (stdDev > 0.2) baseBlur += 16; // busy image needs more blur
              if (avgLuminance > 0.6) baseBlur += 8; // bright image needs more blur
              
              // Overlay opacity for content areas
              let overlayOpacity = 0.4;
              if (avgLuminance > 0.6) overlayOpacity = 0.85; // Very strong overlay for bright images
              else if (avgLuminance > 0.4) overlayOpacity = 0.65;
              else if (avgLuminance < 0.15) overlayOpacity = 0.2; // Very dark image needs minimal overlay
              
              const cssVars = {
                // Global background scrim (consumed by #loom-bg-engine::after)
                "--bg-overlay": overlayOpacity.toFixed(3),
                "--bg-blur": baseBlur + "px",

                // Per-region acrylic (consumed by [data-acrylic="on"] rules)
                "--region-blur-nav": "blur(" + (baseBlur + 12) + "px) saturate(180%)",
                "--region-blur-card": "blur(" + baseBlur + "px) saturate(140%)",
                "--region-blur-modal": "blur(" + (baseBlur + 20) + "px) saturate(200%)",
                "--region-overlay-nav": "color-mix(in oklch, var(--glass) " + Math.round(overlayOpacity * 100) + "%, transparent)",
                "--region-overlay-card": "color-mix(in oklch, var(--surface-1) " + Math.round(overlayOpacity * 100) + "%, transparent)",
                "--region-overlay-modal": "color-mix(in oklch, var(--surface-2) " + Math.round((overlayOpacity + 0.1) * 100) + "%, transparent)"
              };
              
              self.postMessage({
                result: {
                  cssVars,
                  colors: { primary, secondary, surfaceTint },
                  luminance: avgLuminance
                }
              });
            } catch (err) {
              self.postMessage({ error: err.message || String(err) });
            }
          };
        `;
        
        const blob = new Blob([workerCode], { type: "application/javascript" });
        const workerUrl = URL.createObjectURL(blob);
        const worker = new Worker(workerUrl);
        
        worker.onmessage = (event) => {
          URL.revokeObjectURL(workerUrl);
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(event.data.result);
          }
          worker.terminate();
        };
        
        worker.onerror = (err) => {
          URL.revokeObjectURL(workerUrl);
          reject(err);
          worker.terminate();
        };

        const buffer = imgData.data.buffer;
        worker.postMessage({ buffer, width: canvas.width, height: canvas.height }, [buffer]);
      } else {
        // Fallback for non-worker environments
        try {
          const result = runExtractionSync(imgData.data);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }
    };
    
    img.onerror = () => reject(new Error("Failed to load image for processing"));
    img.src = imageUrl;
  });
}

function runExtractionSync(data: Uint8ClampedArray): BackgroundProfile {
  let totalLuminance = 0;
  let rSum = 0, gSum = 0, bSum = 0;
  
  let maxSat1 = -1;
  let vibrant1 = [0, 0, 0];
  
  let maxSat2 = -1;
  let vibrant2 = [0, 0, 0];
  
  const pixelCount = data.length / 4;
  const luminances = new Float32Array(pixelCount);
  
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i+1];
    const b = data[i+2];
    
    rSum += r; gSum += g; bSum += b;
    
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    totalLuminance += lum;
    luminances[p] = lum;
    
    const [h, s, l] = rgbToHsl(r, g, b);
    
    if (l > 0.2 && l < 0.8) {
      const score = s * (1 - Math.abs(l - 0.5));
      if (score > maxSat1) {
        const oldH = rgbToHsl(vibrant1[0], vibrant1[1], vibrant1[2])[0];
        const hueDiff = Math.min(Math.abs(h - oldH), 1 - Math.abs(h - oldH));
        if (hueDiff > 0.1) {
          maxSat2 = maxSat1;
          vibrant2 = [...vibrant1];
        }
        maxSat1 = score;
        vibrant1 = [r, g, b];
      } else if (score > maxSat2) {
        const h1 = rgbToHsl(vibrant1[0], vibrant1[1], vibrant1[2])[0];
        const hueDiff = Math.min(Math.abs(h - h1), 1 - Math.abs(h - h1));
        if (hueDiff > 0.1) {
          maxSat2 = score;
          vibrant2 = [r, g, b];
        }
      }
    }
  }
  
  const avgLuminance = totalLuminance / pixelCount;
  
  let varianceSum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const diff = luminances[i] - avgLuminance;
    varianceSum += diff * diff;
  }
  const variance = varianceSum / pixelCount;
  const stdDev = Math.sqrt(variance);
  
  const avgColor = [Math.round(rSum / pixelCount), Math.round(gSum / pixelCount), Math.round(bSum / pixelCount)];
  
  if (maxSat1 < 0.1) vibrant1 = avgColor;
  if (maxSat2 < 0.1) vibrant2 = vibrant1;
  
  const [avgH, avgS] = rgbToHsl(avgColor[0], avgColor[1], avgColor[2]);
  const surfaceRgb = hslToRgb(avgH, avgS * 0.5, 0.12);
  
  const primary = rgbToHex(vibrant1[0], vibrant1[1], vibrant1[2]);
  const secondary = rgbToHex(vibrant2[0], vibrant2[1], vibrant2[2]);
  const surfaceTint = rgbToHex(surfaceRgb[0], surfaceRgb[1], surfaceRgb[2]);
  
  let baseBlur = 12;
  if (stdDev > 0.2) baseBlur += 16;
  if (avgLuminance > 0.6) baseBlur += 8;
  
  let overlayOpacity = 0.4;
  if (avgLuminance > 0.6) overlayOpacity = 0.85;
  else if (avgLuminance > 0.4) overlayOpacity = 0.65;
  else if (avgLuminance < 0.15) overlayOpacity = 0.2;
  
  const cssVars = {
    "--bg-overlay": overlayOpacity.toFixed(3),
    "--bg-blur": `${baseBlur}px`,
    "--region-blur-nav": `blur(${baseBlur + 12}px) saturate(180%)`,
    "--region-blur-card": `blur(${baseBlur}px) saturate(140%)`,
    "--region-blur-modal": `blur(${baseBlur + 20}px) saturate(200%)`,
    "--region-overlay-nav": `color-mix(in oklch, var(--glass) ${Math.round(overlayOpacity * 100)}%, transparent)`,
    "--region-overlay-card": `color-mix(in oklch, var(--surface-1) ${Math.round(overlayOpacity * 100)}%, transparent)`,
    "--region-overlay-modal": `color-mix(in oklch, var(--surface-2) ${Math.round((overlayOpacity + 0.1) * 100)}%, transparent)`
  };
  
  return {
    cssVars,
    colors: { primary, secondary, surfaceTint },
    luminance: avgLuminance
  };
}
