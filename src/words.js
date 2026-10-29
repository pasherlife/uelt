// Підрахунок слів — порт StatisticsManager.CountWords з десктопної версії UELT.

const WORD = /[\p{L}\p{Nd}]+(?:[_\-*&'’–—][\p{L}\p{Nd}]+)*/gu;
const PLACEHOLDER = /\{[^}]+\}/g;
const TAG = /<[^>]+>/g;
const NUMBER = /^\p{Nd}+$/u;
const PLURAL_KEY = /\b(?:one|few|many|other|microsoft|sony|nintendo)=/g;
const PIPE_PLATFORM = /\|(?:platform|gender|plural|text_gp|fmt)\(([^)]*)\)/g;

export function countWords(text) {
  if (!text || !text.trim()) return 0;

  let cleaned = text.replace(TAG, ' ').replace(PLACEHOLDER, ' ');
  cleaned = cleaned.replace(PIPE_PLATFORM, (_m, inside) => {
    inside = inside.replace(PLURAL_KEY, '');
    return inside.split(',').filter((p) => p.length > 0).join(' ');
  });

  let count = 0;
  for (const m of cleaned.matchAll(WORD)) {
    const word = m[0];
    if (NUMBER.test(word)) continue;
    if (word.includes('_')) continue;
    for (const part of word.split('*')) if (part) count++;
  }
  return count;
}
