// 배포용 zip 만들기 — dist/vignette-chrome-<버전>.zip, dist/vignette-firefox-<버전>.zip
//   node scripts/build.mjs            두 개 다
//   node scripts/build.mjs firefox    하나만
// 파이어폭스는 MV3에서도 service_worker를 안 받아서 manifest만 바꿔 끼운다. 코드는 같다.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const FILES = ['background.js', 'content', 'icons', 'lib', 'manager', 'popup', 'shared'];
const GECKO_ID = 'vignette@lemonpie601';

const base = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function firefoxManifest(m) {
    const out = structuredClone(m);
    out.background = { scripts: ['shared/platforms.js', 'shared/imagedb.js', 'background.js'] };
    out.browser_specific_settings = {
        gecko: {
            id: GECKO_ID,
            strict_min_version: '140.0',
            // 장면 분석 때 채팅 답변 본문을 사용자가 고른 AI 서비스로 보낸다 (PRIVACY.md 3항)
            data_collection_permissions: { required: ['websiteContent'] }
        },
        gecko_android: { strict_min_version: '142.0' }
    };
    return out;
}

const TARGETS = { chrome: m => m, firefox: firefoxManifest };

function build(name) {
    const dir = join(DIST, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of FILES) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(TARGETS[name](base), null, 2) + '\n');
    const zip = join(DIST, `vignette-${name}-${base.version}.zip`);
    rmSync(zip, { force: true });
    execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: dir });
    console.log(`${name}: ${zip}`);
}

const want = process.argv.slice(2);
for (const name of want.length ? want : Object.keys(TARGETS)) {
    if (!TARGETS[name]) { console.error(`모르는 대상: ${name} (chrome | firefox)`); process.exit(1); }
    build(name);
}
