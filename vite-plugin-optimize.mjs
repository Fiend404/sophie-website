import { readdir, readFile, writeFile, mkdir, copyFile, access, unlink, rename, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import sharp from 'sharp';

const CACHE_DIR = resolve('.cache/ext-assets');
const RASTER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export default function optimizeIntegration() {
    return {
        name: 'optimize-assets',
        hooks: {
            'astro:build:done': async ({ dir }) => {
                const distDir = dir.pathname;
                const extDir = join(distDir, 'assets', 'ext');
                const fontsDir = join(extDir, 'fonts');

                await mkdir(extDir, { recursive: true });
                await mkdir(fontsDir, { recursive: true });
                await mkdir(CACHE_DIR, { recursive: true });

                // 1. Compile Tailwind CSS (replaces CDN JIT)
                await compileTailwind(distDir);

                // 2. Find all HTML files
                const htmlFiles = await findHtmlFiles(distDir);
                console.log(`[optimize] Found ${htmlFiles.length} HTML files`);

                // 3. Extract all external URLs
                const htmlContents = new Map();
                const allUrls = new Set();
                for (const f of htmlFiles) {
                    const html = await readFile(f, 'utf-8');
                    htmlContents.set(f, html);
                    for (const url of extractUrls(html)) allUrls.add(url);
                }
                console.log(`[optimize] Found ${allUrls.size} unique external URLs`);

                // 4. Build URL -> local filename map
                const urlToLocal = new Map();
                const usedFilenames = new Set();

                for (const url of allUrls) {
                    const localName = urlToLocalFilename(url, usedFilenames);
                    usedFilenames.add(localName);
                    urlToLocal.set(url, localName);
                }

                // 5. Download all assets (with build cache)
                await downloadAll([...urlToLocal.entries()], extDir);

                // 6. Google Fonts: download CSS, parse font files, rewrite
                const googleFontsUrl = [...allUrls].find(u => u.startsWith('https://fonts.googleapis.com/'));
                if (googleFontsUrl) {
                    await processGoogleFonts(googleFontsUrl, fontsDir);
                }

                // 7. Convert raster images to AVIF
                const avifMap = await convertToAvif(extDir);

                // 8. Extract critical font URLs for preloading
                const criticalFonts = await extractCriticalFonts(join(extDir, 'fonts.css'));

                // 9. Rewrite HTML
                for (const [filePath, originalHtml] of htmlContents) {
                    let html = originalHtml;

                    for (const [externalUrl, localName] of urlToLocal) {
                        if (externalUrl.startsWith('https://fonts.googleapis.com/')) continue;

                        let finalName = localName;
                        if (avifMap.has(finalName)) finalName = avifMap.get(finalName);

                        html = html.replaceAll(externalUrl, `/assets/ext/${finalName}`);
                    }

                    // Replace Google Fonts CSS link
                    if (googleFontsUrl) {
                        html = html.replace(
                            /<link[^>]*href=["'][^"']*fonts\.googleapis\.com\/css2[^"']*["'][^>]*>/g,
                            '<link href="/assets/ext/fonts.css" rel="stylesheet">'
                        );
                    }

                    // Remove preconnect links for Google Fonts
                    html = html.replace(/<link[^>]*(?:href=["']https:\/\/fonts\.googleapis\.com["'][^>]*rel=["']preconnect["']|rel=["']preconnect["'][^>]*href=["']https:\/\/fonts\.googleapis\.com["'])[^>]*>\n?/g, '');
                    html = html.replace(/<link[^>]*(?:href=["']https:\/\/fonts\.gstatic\.com["'][^>]*rel=["']preconnect["']|rel=["']preconnect["'][^>]*href=["']https:\/\/fonts\.gstatic\.com["'])[^>]*>\n?/g, '');

                    // Inject preload hints for critical assets
                    html = injectPreloads(html, criticalFonts);

                    await writeFile(filePath, html);
                }

                // 10. Brotli compress HTML (cached)
                const brotliCacheDir = join(CACHE_DIR, 'brotli');
                await mkdir(brotliCacheDir, { recursive: true });
                let totalOriginal = 0;
                let totalCompressed = 0;
                let brotliCached = 0;
                for (const f of htmlFiles) {
                    const content = await readFile(f);
                    const hash = createHash('sha256').update(content).digest('hex');
                    const cachedBrPath = join(brotliCacheDir, hash + '.br');
                    let compressed;

                    if (await fileExists(cachedBrPath)) {
                        compressed = await readFile(cachedBrPath);
                        brotliCached++;
                    } else {
                        compressed = brotliCompressSync(content, {
                            params: {
                                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                            }
                        });
                        await writeFile(cachedBrPath, compressed);
                    }
                    await writeFile(f + '.br', compressed);
                    totalOriginal += content.length;
                    totalCompressed += compressed.length;
                }

                console.log(`[optimize] Brotli: ${fmt(totalOriginal)} -> ${fmt(totalCompressed)} (${Math.round(totalCompressed / totalOriginal * 100)}%), ${brotliCached} from cache`);
                console.log('[optimize] Done!');
            }
        }
    };
}

// --- Tailwind CSS Compilation ---

async function compileTailwind(distDir) {
    const inputCss = resolve('src/styles/tailwind.css');
    const outputCss = join(distDir, 'assets', 'ext', 'tailwind.css');

    execSync(
        `npx @tailwindcss/cli -i ${inputCss} -o ${outputCss} --content '${distDir}/**/*.html' --minify`,
        { stdio: 'pipe' }
    );

    const size = (await stat(outputCss)).size;
    console.log(`[optimize] Tailwind compiled: ${fmt(size)}`);

    // Replace CDN script + inline config with stylesheet link in all HTML files
    const htmlFiles = await findHtmlFiles(distDir);
    for (const f of htmlFiles) {
        let html = await readFile(f, 'utf-8');

        html = html.replace(/<script[^>]*src=["'][^"']*tailwindcss[^"']*["'][^>]*><\/script>\s*/g, '');
        html = html.replace(/<script>\s*tailwind\.config\s*=\s*\{[\s\S]*?\}\s*<\/script>\s*/g, '');

        if (!html.includes('tailwind.css')) {
            html = html.replace(/<head>/, '<head>\n<link rel="stylesheet" href="/assets/ext/tailwind.css">');
        }

        await writeFile(f, html);
    }
}

// --- URL Extraction ---

function extractUrls(html) {
    const urls = new Set();

    for (const m of html.matchAll(/(?:src|href)=["'](https:\/\/(?:cdn\.prod\.website-files\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|cdn\.tailwindcss\.com)[^"']*?)["']/g)) {
        urls.add(m[1]);
    }

    for (const m of html.matchAll(/href=["'](https:\/\/fonts\.googleapis\.com\/css2[^"']*?)["']/g)) {
        urls.add(m[1]);
    }

    for (const m of html.matchAll(/url\(['"]?(https:\/\/[^"')]+?)['"]?\)/g)) {
        urls.add(m[1]);
    }

    for (const m of html.matchAll(/data-lottie-path=["'](https:\/\/[^"']+?)["']/g)) {
        urls.add(m[1]);
    }

    for (const m of html.matchAll(/srcset=["']([^"']+?)["']/g)) {
        for (const entry of m[1].split(',')) {
            const url = entry.trim().split(/\s+/)[0];
            if (url.startsWith('https://')) urls.add(url);
        }
    }

    for (const m of html.matchAll(/['"](https:\/\/cdn\.prod\.website-files\.com\/[^"'\s,}]+?\.(?:mp3|mp4|wav|ogg|webp|jpg|jpeg|png|svg|json|gif))['"]?/g)) {
        urls.add(m[1]);
    }

    return urls;
}

// --- Filename Generation ---

function urlToLocalFilename(url, usedFilenames) {
    const parsed = new URL(url);

    if (parsed.hostname === 'cdn.tailwindcss.com') return 'tailwindcss.js';

    if (parsed.hostname === 'cdn.jsdelivr.net') {
        if (url.includes('alpinejs/collapse') || url.includes('@alpinejs/collapse')) {
            return 'alpinejs-collapse-cdn.min.js';
        }
        if (url.includes('alpinejs@') || url.includes('/alpinejs/')) {
            return 'alpinejs-cdn.min.js';
        }
    }

    if (parsed.hostname === 'fonts.googleapis.com') return 'google-fonts.css';

    const pathParts = parsed.pathname.split('/');
    let filename = decodeURIComponent(pathParts[pathParts.length - 1] || 'index');

    if (usedFilenames.has(filename)) {
        const hash = createHash('md5').update(url).digest('hex').slice(0, 8);
        const ext = extname(filename);
        const base = ext ? filename.slice(0, -ext.length) : filename;
        filename = `${base}-${hash}${ext}`;
    }

    return filename;
}

// --- Cache + Download ---

function cacheKey(url) {
    return createHash('sha256').update(url).digest('hex');
}

async function fileExists(path) {
    try { await access(path); return true; } catch { return false; }
}

async function cachedDownload(url, destPath) {
    const key = cacheKey(url);
    const cachedPath = join(CACHE_DIR, key);

    if (await fileExists(cachedPath)) {
        await copyFile(cachedPath, destPath);
        return true;
    }

    const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
    });
    if (!resp.ok) {
        console.warn(`[optimize] Failed to download ${url}: ${resp.status}`);
        return false;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    await writeFile(cachedPath, buffer);
    await copyFile(cachedPath, destPath);
    return false;
}

async function downloadAll(entries, extDir) {
    const CONCURRENCY = 10;
    let downloaded = 0;
    let cached = 0;
    const queue = [...entries];

    const work = async () => {
        while (queue.length > 0) {
            const [url, localName] = queue.shift();
            const dest = join(extDir, localName);
            const wasCached = await cachedDownload(url, dest);
            if (wasCached) cached++; else downloaded++;
        }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => work()));
    console.log(`[optimize] Assets: ${downloaded} downloaded, ${cached} from cache`);
}

// --- Google Fonts ---

async function processGoogleFonts(googleFontsUrl, fontsDir) {
    const key = cacheKey(googleFontsUrl);
    const cachedCssPath = join(CACHE_DIR, key + '-css');
    let css;

    if (await fileExists(cachedCssPath)) {
        css = await readFile(cachedCssPath, 'utf-8');
    } else {
        const resp = await fetch(googleFontsUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
        });
        css = await resp.text();
        await writeFile(cachedCssPath, css);
    }

    const fontUrls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)].map(m => m[1]);
    const fontFilenames = new Set();

    for (const fontUrl of fontUrls) {
        const parts = fontUrl.split('/');
        let filename = parts[parts.length - 1];
        if (fontFilenames.has(filename)) {
            const hash = createHash('md5').update(fontUrl).digest('hex').slice(0, 8);
            const dotIdx = filename.indexOf('.');
            filename = dotIdx >= 0
                ? `${filename.slice(0, dotIdx)}-${hash}${filename.slice(dotIdx)}`
                : `${filename}-${hash}`;
        }
        fontFilenames.add(filename);

        await cachedDownload(fontUrl, join(fontsDir, filename));
        css = css.replaceAll(fontUrl, `/assets/ext/fonts/${filename}`);
    }

    await writeFile(join(fontsDir, '..', 'fonts.css'), css);
    console.log(`[optimize] Google Fonts: ${fontUrls.length} font files processed`);
}

// --- AVIF Conversion ---

async function convertToAvif(extDir) {
    const avifMap = new Map();
    const avifCacheDir = join(CACHE_DIR, 'avif');
    await mkdir(avifCacheDir, { recursive: true });

    const files = await readdir(extDir);
    let converted = 0, cached = 0;

    for (const file of files) {
        const ext = extname(file).toLowerCase();
        if (!RASTER_EXTS.has(ext)) continue;

        const inputPath = join(extDir, file);
        const avifName = file.replace(/\.[^.]+$/, '.avif');
        const outputPath = join(extDir, avifName);

        const content = await readFile(inputPath);
        const hash = createHash('sha256').update(content).digest('hex');
        const cachedAvifPath = join(avifCacheDir, hash + '.avif');

        try {
            if (await fileExists(cachedAvifPath)) {
                await copyFile(cachedAvifPath, outputPath);
                cached++;
            } else {
                await sharp(inputPath).avif({ quality: 60, effort: 6 }).toFile(outputPath);
                await copyFile(outputPath, cachedAvifPath);
                converted++;
            }
            await unlink(inputPath);
            avifMap.set(file, avifName);
        } catch (e) {
            console.warn(`[optimize] AVIF conversion failed for ${file}: ${e.message}`);
        }
    }

    console.log(`[optimize] AVIF: ${converted} converted, ${cached} from cache`);
    return avifMap;
}

// --- Preload Injection ---

async function extractCriticalFonts(fontsCssPath) {
    try {
        const css = await readFile(fontsCssPath, 'utf-8');
        const fonts = [];
        const blocks = css.split('@font-face');
        for (const block of blocks) {
            const isLatin = /unicode-range:.*U\+0000-00FF/.test(block);
            const weight = block.match(/font-weight:\s*(\d+)/)?.[1];
            const urlMatch = block.match(/url\(([^)]+\.woff2)\)/);
            if (isLatin && urlMatch && (weight === '400' || weight === '700')) {
                fonts.push(urlMatch[1]);
            }
        }
        return fonts;
    } catch {
        return [];
    }
}

function injectPreloads(html, criticalFonts) {
    const preloads = [];

    // Preload fonts CSS
    if (html.includes('/assets/ext/fonts.css')) {
        preloads.push('<link rel="preload" href="/assets/ext/fonts.css" as="style">');
    }

    // Preload compiled Tailwind CSS
    if (html.includes('/assets/ext/tailwind.css')) {
        preloads.push('<link rel="preload" href="/assets/ext/tailwind.css" as="style">');
    }

    // Preload Alpine.js
    if (html.includes('/assets/ext/alpinejs-cdn.min.js')) {
        preloads.push('<link rel="preload" href="/assets/ext/alpinejs-cdn.min.js" as="script">');
    }

    // Preload critical font files (latin, weight 400 + 700, deduped)
    const seenFonts = new Set();
    for (const fontPath of criticalFonts) {
        if (seenFonts.has(fontPath)) continue;
        seenFonts.add(fontPath);
        preloads.push(`<link rel="preload" href="${fontPath}" as="font" type="font/woff2" crossorigin>`);
    }

    if (preloads.length === 0) return html;

    return html.replace(/<head>/, `<head>\n${preloads.join('\n')}`);
}

// --- HTML File Discovery ---

async function findHtmlFiles(dir) {
    const results = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'assets') {
            results.push(...await findHtmlFiles(fullPath));
        } else if (entry.name.endsWith('.html')) {
            results.push(fullPath);
        }
    }
    return results;
}

// --- Utilities ---

function fmt(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
