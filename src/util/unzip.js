'use strict';
/*
 * Минимальное чтение ZIP (для .1pux): центральный каталог + stored/deflate.
 * Распаковка — встроенным DecompressionStream('deflate-raw'), без библиотек.
 */

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** Список файлов архива: [{ name, method, size, compSize, offset }]. */
function listZip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 22 || u32(b, 0) !== 0x04034b50) throw new Error('Это не ZIP-архив');
  // конец центрального каталога ищем с конца (там может быть комментарий)
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Архив повреждён: не найден каталог файлов');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const dec = new TextDecoder();
  const files = [];
  for (let i = 0; i < count; i++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('Архив повреждён');
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    files.push({ name, method, size, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { bytes: b, files };
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Распаковка ZIP не поддерживается этой версией приложения');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Содержимое одного файла архива (Uint8Array). */
async function readZipFile(zip, entry) {
  const b = zip.bytes;
  const p = entry.offset;
  if (u32(b, p) !== 0x04034b50) throw new Error(`Архив повреждён: ${entry.name}`);
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  const data = b.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data.slice();
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`Неподдерживаемое сжатие (${entry.method}) у ${entry.name}`);
}

module.exports = { listZip, readZipFile };
