#!/usr/bin/env node
/**
 * Build-time HTML preprocessor for MeshCommanderMac.
 *
 * Reads the vendor index.html (marker-block templated, in the WebSite Compiler
 * style: <!-- ###BEGIN###{Name} --> ... <!-- ###END###{Name} --> and the JS
 * comment equivalent // ###BEGIN###{Name} ... // ###END###{Name}) and strips
 * blocks whose feature name isn't in the enabled feature list, producing a
 * plain static HTML file with no leftover markers.
 *
 * Never edits vendor files in place. Reads <repoRoot>/index.html, writes
 * <outputHtml> (default MeshCommanderMac/Resources/index-mac.html), and copies
 * every local (non-http, non-data:) asset the generated HTML references into
 * the same directory as <outputHtml>, preserving relative paths.
 *
 * Usage:
 *   node Scripts/build-html.js [--features Scripts/features-phase1.json]
 *                               [--input index.html]
 *                               [--output MeshCommanderMac/Resources/index-mac.html]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
    const args = {
        features: path.join('Scripts', 'features-phase1.json'),
        input: 'index.html',
        output: path.join('MeshCommanderMac', 'Resources', 'index-mac.html'),
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--features') { args.features = argv[++i]; }
        else if (a === '--input') { args.input = argv[++i]; }
        else if (a === '--output') { args.output = argv[++i]; }
        else { throw new Error('Unknown argument: ' + a); }
    }
    return args;
}

// Matches a marker line in either comment style. Group 2 = BEGIN|END, group 3 = raw name (with any !/** prefix).
const MARKER_RE = /^\s*(?:<!--\s*###(BEGIN|END)###\{([^}]*)\}\s*-->|\/\/\s*###(BEGIN|END)###\{([^}]*)\})\s*$/;

function parseMarker(line) {
    const m = MARKER_RE.exec(line);
    if (!m) return null;
    const kind = m[1] || m[3];
    const rawName = m[2] !== undefined ? m[2] : m[4];
    return { kind, rawName };
}

function stripNamePrefix(rawName) {
    if (rawName.startsWith('**')) return { name: rawName.slice(2), negate: false, closure: true };
    if (rawName.startsWith('!')) return { name: rawName.slice(1), negate: true, closure: false };
    return { name: rawName, negate: false, closure: false };
}

// Single-pass scan: build a stack of open frames (matched by exact raw name,
// searched from the top down on END so out-of-order-but-non-overlapping
// crossings like ###BEGIN###{A} ###BEGIN###{B} ###END###{A} ###END###{B}
// resolve the same as if they were properly nested (B still requires A).
function computeFrames(lines, enabledSet) {
    const stack = [];
    const frames = [];
    for (let i = 0; i < lines.length; i++) {
        const marker = parseMarker(lines[i]);
        if (!marker) continue;
        if (marker.kind === 'BEGIN') {
            const { name, negate, closure } = stripNamePrefix(marker.rawName);
            const ownKeep = closure ? false : (negate ? !enabledSet.has(name) : enabledSet.has(name));
            const parentEffectiveKeep = stack.length ? stack[stack.length - 1].effectiveKeep : true;
            stack.push({
                rawName: marker.rawName,
                beginLineIndex: i,
                ownKeep,
                effectiveKeep: ownKeep && parentEffectiveKeep,
            });
        } else {
            let idx = -1;
            for (let j = stack.length - 1; j >= 0; j--) {
                if (stack[j].rawName === marker.rawName) { idx = j; break; }
            }
            if (idx === -1) {
                throw new Error('Unmatched ###END###{' + marker.rawName + '} at line ' + (i + 1) + ' (no open BEGIN with that name)');
            }
            const frame = stack[idx];
            stack.splice(idx, 1);
            frames.push({ beginLineIndex: frame.beginLineIndex, endLineIndex: i, effectiveKeep: frame.effectiveKeep });
        }
    }
    if (stack.length > 0) {
        const names = stack.map(function (f) { return f.rawName + ' (line ' + (f.beginLineIndex + 1) + ')'; }).join(', ');
        throw new Error('Unclosed marker block(s) at EOF: ' + names);
    }
    return frames;
}

function mergeRanges(ranges) {
    if (ranges.length === 0) return [];
    ranges.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    const merged = [ranges[0].slice()];
    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        const cur = ranges[i];
        if (cur[0] <= last[1] + 1) { last[1] = Math.max(last[1], cur[1]); }
        else { merged.push(cur.slice()); }
    }
    return merged;
}

function isDeleted(mergedRanges, lineIndex) {
    // mergedRanges is sorted; linear scan is fine at this file size (~15k lines).
    for (let i = 0; i < mergedRanges.length; i++) {
        const r = mergedRanges[i];
        if (lineIndex < r[0]) return false;
        if (lineIndex <= r[1]) return true;
    }
    return false;
}

// project.yml's MARKETING_VERSION is the single source of truth for the app's version
// (it already drives the native bundle's CFBundleShortVersionString) - read it with a
// narrow regex rather than pulling in a YAML dependency for one flat scalar value.
function readMarketingVersion() {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'project.yml'), 'utf8');
    const m = /MARKETING_VERSION:\s*"([^"]+)"/.exec(text);
    if (!m) throw new Error('Could not find MARKETING_VERSION in project.yml');
    return m[1];
}

function buildHtml(inputPath, enabledFeatures) {
    const enabledSet = new Set(enabledFeatures);
    const raw = fs.readFileSync(inputPath, 'utf8');
    const lines = raw.split('\n');
    const frames = computeFrames(lines, enabledSet);

    const deleteRanges = [];
    for (const frame of frames) {
        if (!frame.effectiveKeep) {
            deleteRanges.push([frame.beginLineIndex, frame.endLineIndex]);
        } else {
            deleteRanges.push([frame.beginLineIndex, frame.beginLineIndex]);
            deleteRanges.push([frame.endLineIndex, frame.endLineIndex]);
        }
    }
    const merged = mergeRanges(deleteRanges);

    const featureListLiteral = enabledFeatures.map(function (f) { return JSON.stringify(f); }).join(',');

    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (isDeleted(merged, i)) continue;
        let line = lines[i];
        if (line.indexOf('###WEBCOMPILERFEATURES###') >= 0) {
            line = line.replace('/*###WEBCOMPILERFEATURES###*/', featureListLiteral);
        }
        const trimmed = line.trim();
        if (trimmed === '<script type="text/javascript" src="common-0.0.1.js"></script>') {
            out.push('    <script type="text/javascript" src="node-shim.js"></script>');
        }
        out.push(line);
        if (trimmed === '<script type="text/javascript" src="amt-certificates-0.0.1.js"></script>') {
            out.push('    <script type="text/javascript" src="md5-shim.js"></script>');
        }
    }

    // The Language menu (NW_SetupMainMenu, index.html) navigates via
    // window.location.href = 'commander.htm' / 'commander_XX.htm' - vendor's
    // Windows "website compiler" output naming, not ours. Rewrite to the real
    // per-language filenames this script generates (see build-release.sh),
    // which all live side by side in Resources/ under file://, same origin.
    let html = out.join('\n');
    html = html.replace(/window\.location\.href = 'commander(_[a-z-]+)?\.htm'/g, function (_, suffix) {
        return "window.location.href = 'index-mac" + (suffix || '') + ".html'";
    });

    // Override the vendor's own hardcoded `var version = '...';` (independently drifted from
    // project.yml's MARKETING_VERSION - see readMarketingVersion) so the in-app UI header
    // always matches the native app bundle's version.
    html = html.replace(/var version = '[^']*';/g, "var version = '" + readMarketingVersion() + "';");

    return html;
}

// Scan the generated HTML for local asset references (script src / link href / img src)
// so we know what to copy alongside index-mac.html. Skips data: URIs and absolute http(s) URLs.
function findLocalAssetRefs(html) {
    const refs = new Set();
    const attrRe = /\b(?:src|href)="([^"]+)"/g;
    let m;
    while ((m = attrRe.exec(html)) !== null) {
        const ref = m[1];
        if (ref.startsWith('data:') || /^[a-z]+:\/\//i.test(ref) || ref.startsWith('#')) continue;
        refs.add(ref);
    }
    return Array.from(refs);
}

function copyFile(srcAbs, destAbs) {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
}

function copyDirRecursive(srcAbs, destAbs) {
    fs.mkdirSync(destAbs, { recursive: true });
    for (const entry of fs.readdirSync(srcAbs, { withFileTypes: true })) {
        const s = path.join(srcAbs, entry.name);
        const d = path.join(destAbs, entry.name);
        if (entry.isDirectory()) copyDirRecursive(s, d);
        else fs.copyFileSync(s, d);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const inputPath = path.resolve(REPO_ROOT, args.input);
    const outputPath = path.resolve(REPO_ROOT, args.output);
    const featuresPath = path.resolve(REPO_ROOT, args.features);
    const outputDir = path.dirname(outputPath);

    const enabledFeatures = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
    if (!Array.isArray(enabledFeatures)) throw new Error('Features file must be a JSON array of strings: ' + featuresPath);

    const html = buildHtml(inputPath, enabledFeatures);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');

    // node-shim.js / md5-shim.js are hand-written and already checked in under Resources/; don't
    // try to copy them from the repo root (they don't exist there).
    const HAND_WRITTEN = new Set(['node-shim.js', 'md5-shim.js']);

    const refs = findLocalAssetRefs(html);
    let copied = 0;
    for (const ref of refs) {
        const rel = ref.split('?')[0].split('#')[0];
        if (HAND_WRITTEN.has(rel)) continue;
        const srcAbs = path.resolve(REPO_ROOT, rel);
        if (!fs.existsSync(srcAbs)) {
            console.warn('warning: referenced asset not found, skipping: ' + rel);
            continue;
        }
        copyFile(srcAbs, path.join(outputDir, rel));
        copied++;
    }

    // Images referenced only via runtime string concatenation in JS (e.g. computer-selector
    // icons) won't show up in a static src="" scan - copy these directories wholesale.
    const WHOLESALE_DIRS = ['images-commander', 'images'];
    for (const dir of WHOLESALE_DIRS) {
        const srcAbs = path.resolve(REPO_ROOT, dir);
        if (fs.existsSync(srcAbs)) copyDirRecursive(srcAbs, path.join(outputDir, dir));
    }
    for (const f of ['favicon.png', 'favicon.ico']) {
        const srcAbs = path.resolve(REPO_ROOT, f);
        if (fs.existsSync(srcAbs)) copyFile(srcAbs, path.join(outputDir, f));
    }

    console.log('Wrote ' + path.relative(REPO_ROOT, outputPath) + ' (' + enabledFeatures.length + ' features enabled, ' + copied + ' referenced assets copied)');
}

main();
