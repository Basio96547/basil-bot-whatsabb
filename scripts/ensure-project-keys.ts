// يضمن أن في .env مفتاح PROJECT_API_KEY_<ID> لكل مشروع في config/projects.json.
// يُشغَّل عبر scripts/ensure-project-keys.sh (راجع رأسه لسبب الوجود).
//
// الحضور يُقرَّر بمحلّل dotenv نفسه لا بـ grep: `NAME=\r` (ملف حُرِّر على
// ويندوز) و`NAME=""` كانا يُعدّان موجودين فلا يُولَّد المفتاح ويفشل الإقلاع في
// كل مرة، و`export NAME=x` أو سطر بمسافة بادئة لم يُعرفا فأُضيف مفتاح ثانٍ —
// وdotenv يأخذ الأخير، أي تدوير صامت لمفتاح يستعمله موقع حيّ.
//
// والإضافة لا تلتصق بآخر سطر: ملف بلا سطر جديد في نهايته كان يصير
// `…=storekey123PROJECT_API_KEY_FIREWORKS=…`، فيُفسد مفتاح المتجر بصمت.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

const ENV_PATH = '.env';

interface Project {
  id: string;
}

const projects = JSON.parse(readFileSync('config/projects.json', 'utf-8')) as Project[];
let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';

// Lines split with their own endings kept, so everything not touched below
// is written back byte for byte (CRLF included).
function lines(): string[] {
  return text.split(/(?<=\n)/).filter((line) => line.length > 0);
}

function definesName(line: string, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(dotenv.parse(line), name);
}

let changed = false;
const created: Array<{ name: string; value: string }> = [];

for (const { id } of projects) {
  const name = `PROJECT_API_KEY_${id.toUpperCase()}`;

  // Blank definitions go first: they are what makes the effective value empty
  // when a real one also exists earlier in the file (dotenv keeps the last).
  const kept = lines().filter((line) => !(definesName(line, name) && dotenv.parse(line)[name].trim() === ''));
  if (kept.join('') !== text) {
    text = kept.join('');
    changed = true;
  }

  const current = (dotenv.parse(text)[name] ?? '').trim();
  if (current) {
    if (current.toLowerCase().startsWith('change-me')) {
      console.log(`  !!! ${name} ما زال القيمة المثالية من .env.example — الخدمة سترفض الإقلاع.`);
      console.log(`      احذف السطر ثم أعد التشغيل ليُولَّد مفتاح حقيقي، وحدّث الموقع الذي يستعمله.`);
    } else {
      console.log(`  ${name} موجود — تُرك كما هو`);
    }
    continue;
  }

  const value = randomBytes(24).toString('hex');
  if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  text += `${name}=${value}\n`;
  changed = true;
  created.push({ name, value });
}

if (changed) {
  // Replaced in one rename: a crash halfway through a plain write would leave
  // a truncated .env — every key gone, and the service unable to boot.
  writeFileSync(`${ENV_PATH}.tmp`, text, { encoding: 'utf-8', mode: 0o600 });
  renameSync(`${ENV_PATH}.tmp`, ENV_PATH);
}

// The generated key is printed only to a real terminal: push-to-phone.ps1
// redirects everything to a log on /sdcard, readable by any app with storage
// permission.
for (const { name, value } of created) {
  if (process.stdout.isTTY) {
    console.log(`  أُنشئ ${name} — انسخ القيمة التالية إلى secret الووركر المقابل (SMS_API_KEY):`);
    console.log('');
    console.log(`      ${value}`);
    console.log('');
  } else {
    console.log(`  أُنشئ ${name} — القيمة محفوظة في .env ولم تُطبع (المخرجات تُكتب في سجل).`);
    console.log(`  اقرأها لاحقاً: adb shell "run-as com.termux grep ${name} files/home/sms-api/.env"`);
  }
}
