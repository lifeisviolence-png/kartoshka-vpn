// Country metadata and detection for the server list.
//
// Priority: an explicit flag emoji in the provider name, then a country name or
// ISO code, then a well-known city, and finally the offline IP database in the
// desktop core. Nothing here performs a network request.
export const COUNTRIES = [
  ['ae', 'ОАЭ', 'United Arab Emirates', ['uae', 'emirates', 'дубай', 'dubai', 'abu dhabi', 'абу-даби']],
  ['am', 'Армения', 'Armenia', ['yerevan', 'ереван']],
  ['ar', 'Аргентина', 'Argentina', ['buenos aires', 'буэнос-айрес']],
  ['at', 'Австрия', 'Austria', ['vienna', 'wien', 'вена']],
  ['au', 'Австралия', 'Australia', ['sydney', 'сидней', 'melbourne', 'мельбурн']],
  ['az', 'Азербайджан', 'Azerbaijan', ['baku', 'баку']],
  ['be', 'Бельгия', 'Belgium', ['brussels', 'брюссель']],
  ['bg', 'Болгария', 'Bulgaria', ['sofia', 'софия']],
  ['br', 'Бразилия', 'Brazil', ['sao paulo', 'сан-паулу', 'rio de janeiro', 'рио-де-жанейро']],
  ['by', 'Беларусь', 'Belarus', ['minsk', 'минск', 'белоруссия']],
  ['ca', 'Канада', 'Canada', ['toronto', 'торонто', 'montreal', 'монреаль', 'vancouver', 'ванкувер']],
  ['ch', 'Швейцария', 'Switzerland', ['zurich', 'zürich', 'цюрих', 'geneva', 'женевa', 'женева']],
  ['cl', 'Чили', 'Chile', ['santiago', 'сантьяго']],
  ['cn', 'Китай', 'China', ['hong kong', 'гонконг', 'shanghai', 'шанхай', 'beijing', 'пекин']],
  ['co', 'Колумбия', 'Colombia', ['bogota', 'богота']],
  ['cy', 'Кипр', 'Cyprus', ['nicosia', 'никосия', 'limassol', 'лимассол']],
  ['cz', 'Чехия', 'Czechia', ['czech republic', 'prague', 'прага', 'brno', 'брно']],
  ['de', 'Германия', 'Germany', ['germany', 'deutschland', 'frankfurt', 'франкфурт', 'berlin', 'берлин', 'munich', 'мюнхен', 'hamburg', 'гамбург', 'nuremberg', 'нюрнберг', 'dusseldorf', 'дюссельдорф']],
  ['dk', 'Дания', 'Denmark', ['copenhagen', 'копенгаген']],
  ['ee', 'Эстония', 'Estonia', ['tallinn', 'таллин', 'таллинн']],
  ['eg', 'Египет', 'Egypt', ['cairo', 'каир']],
  ['es', 'Испания', 'Spain', ['madrid', 'мадрид', 'barcelona', 'барселона']],
  ['fi', 'Финляндия', 'Finland', ['helsinki', 'хельсинки', 'espoo', 'эспоо']],
  ['fr', 'Франция', 'France', ['paris', 'париж', 'marseille', 'марсель', 'gravelines', 'гравелин']],
  ['gb', 'Великобритания', 'United Kingdom', ['uk', 'great britain', 'england', 'britain', 'london', 'лондон', 'manchester', 'манчестер', 'англия']],
  ['ge', 'Грузия', 'Georgia', ['tbilisi', 'тбилиси']],
  ['gr', 'Греция', 'Greece', ['athens', 'афины']],
  ['hk', 'Гонконг', 'Hong Kong', ['hongkong', 'hong-kong']],
  ['hr', 'Хорватия', 'Croatia', ['zagreb', 'загреб']],
  ['hu', 'Венгрия', 'Hungary', ['budapest', 'будапешт']],
  ['id', 'Индонезия', 'Indonesia', ['jakarta', 'джакарта']],
  ['ie', 'Ирландия', 'Ireland', ['dublin', 'дублин']],
  ['il', 'Израиль', 'Israel', ['tel aviv', 'тель-авив']],
  ['in', 'Индия', 'India', ['mumbai', 'мумбаи', 'delhi', 'дели', 'bangalore', 'бангалор']],
  ['ir', 'Иран', 'Iran', ['tehran', 'тегеран']],
  ['is', 'Исландия', 'Iceland', ['reykjavik', 'рейкьявик']],
  ['it', 'Италия', 'Italy', ['milan', 'милан', 'rome', 'рим']],
  ['jp', 'Япония', 'Japan', ['tokyo', 'токио', 'osaka', 'осака']],
  ['kr', 'Южная Корея', 'South Korea', ['korea', 'seoul', 'сеул', 'корея']],
  ['kz', 'Казахстан', 'Kazakhstan', ['almaty', 'алматы', 'astana', 'астана']],
  ['lt', 'Литва', 'Lithuania', ['vilnius', 'вильнюс']],
  ['lu', 'Люксембург', 'Luxembourg', []],
  ['lv', 'Латвия', 'Latvia', ['riga', 'рига']],
  ['md', 'Молдова', 'Moldova', ['chisinau', 'кишинёв', 'кишинев', 'молдавия']],
  ['mx', 'Мексика', 'Mexico', ['mexico city', 'мехико']],
  ['my', 'Малайзия', 'Malaysia', ['kuala lumpur', 'куала-лумпур']],
  ['ng', 'Нигерия', 'Nigeria', ['lagos', 'лагос']],
  ['nl', 'Нидерланды', 'Netherlands', ['holland', 'amsterdam', 'амстердам', 'rotterdam', 'роттердам', 'гаага', 'the hague']],
  ['no', 'Норвегия', 'Norway', ['oslo', 'осло']],
  ['nz', 'Новая Зеландия', 'New Zealand', ['auckland', 'окленд']],
  ['pe', 'Перу', 'Peru', ['lima', 'лима']],
  ['ph', 'Филиппины', 'Philippines', ['manila', 'манила']],
  ['pk', 'Пакистан', 'Pakistan', ['karachi', 'карачи']],
  ['pl', 'Польша', 'Poland', ['warsaw', 'варшава', 'krakow', 'краков']],
  ['pt', 'Португалия', 'Portugal', ['lisbon', 'лиссабон']],
  ['ro', 'Румыния', 'Romania', ['bucharest', 'бухарест']],
  ['rs', 'Сербия', 'Serbia', ['belgrade', 'белград']],
  ['ru', 'Россия', 'Russia', ['moscow', 'москва', 'saint petersburg', 'санкт-петербург', 'russian federation', 'рф']],
  ['sa', 'Саудовская Аравия', 'Saudi Arabia', ['riyadh', 'эр-рияд']],
  ['se', 'Швеция', 'Sweden', ['stockholm', 'стокгольм']],
  ['sg', 'Сингапур', 'Singapore', []],
  ['si', 'Словения', 'Slovenia', ['ljubljana', 'любляна']],
  ['sk', 'Словакия', 'Slovakia', ['bratislava', 'братислава']],
  ['th', 'Таиланд', 'Thailand', ['bangkok', 'бангкок']],
  ['tr', 'Турция', 'Turkey', ['türkiye', 'turkiye', 'istanbul', 'стамбул', 'ankara', 'анкара']],
  ['tw', 'Тайвань', 'Taiwan', ['taipei', 'тайбэй']],
  ['ua', 'Украина', 'Ukraine', ['kyiv', 'kiev', 'киев', 'харьков', 'kharkiv', 'одесса', 'odessa']],
  ['us', 'США', 'United States', ['usa', 'america', 'united states', 'new york', 'нью-йорк', 'los angeles', 'лос-анджелес', 'chicago', 'чикаго', 'dallas', 'даллас', 'miami', 'майами', 'seattle', 'сиэтл', 'atlanta', 'атланта', 'ashburn', 'эшберн', 'phoenix', 'финикс', 'denver', 'денвер']],
  ['uz', 'Узбекистан', 'Uzbekistan', ['tashkent', 'ташкент']],
  ['vn', 'Вьетнам', 'Vietnam', ['hanoi', 'ханой']],
  ['za', 'ЮАР', 'South Africa', ['johannesburg', 'йоханнесбург', 'cape town', 'кейптаун']]
].map(([code, ru, en, aliases]) => ({ code, ru, en, aliases, emoji: String.fromCodePoint(...[...code.toUpperCase()].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65)) }));

const BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]));
export const UNKNOWN_COUNTRY = { code: '', ru: '', en: '', aliases: [], emoji: '🌐' };

export function countryByCode(code) {
  return BY_CODE.get(String(code || '').toLowerCase()) || null;
}

export function countryLabel(code, language = 'ru') {
  const country = countryByCode(code);
  if (!country) return '';
  return language === 'en' ? country.en : country.ru;
}

// A flag is an image, not an emoji: Windows does not render regional-indicator
// pairs as flags. The SVG set is bundled, so no CDN is involved.
export function flagPath(code) {
  const country = countryByCode(code);
  return country ? `/flags/${country.code}.svg` : '';
}

const boundary = (text, index, length) => {
  const before = index > 0 ? text[index - 1] : '';
  const after = text[index + length] || '';
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
};

function findAlias(text, alias) {
  const needle = alias.toLowerCase();
  let from = 0;
  while (from <= text.length - needle.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) return -1;
    if (boundary(text, index, needle.length)) return index;
    from = index + 1;
  }
  return -1;
}

export function emojiCountry(text) {
  const value = String(text || '');
  const match = value.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  if (!match) return '';
  const code = [...match[0]].map((letter) => String.fromCharCode(letter.codePointAt(0) - 0x1f1e6 + 65)).join('').toLowerCase();
  return countryByCode(code) ? code : '';
}

// ISO codes are matched only as explicit tokens (DE, DE-1, [DE], de_2). Plain
// lowercase words such as "in", "no" or "me" are never treated as a country.
export function isoCountry(text) {
  const value = String(text || '');
  const tokens = value.match(/(?:^|[^\p{L}\p{N}])([A-Z]{2})(?=$|[^\p{L}\p{N}])/gu) || [];
  for (const token of tokens) {
    const code = token.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (BY_CODE.has(code)) return code;
  }
  return '';
}

export function nameCountry(text) {
  const value = String(text || '').toLowerCase();
  let best = null;
  for (const country of COUNTRIES) {
    for (const alias of [country.ru, country.en, ...country.aliases]) {
      if (!alias) continue;
      const index = findAlias(value, alias);
      if (index < 0) continue;
      if (!best || alias.length > best.length) best = { code: country.code, length: alias.length };
    }
  }
  return best?.code || '';
}

// Detection order is deliberate: an explicit emoji beats a country name, a name
// beats an incidental two-letter token, and the city is the last text hint.
export function detectCountry(name, extra = '') {
  const text = `${name || ''} ${extra || ''}`.trim();
  if (!text) return { code: '', source: '' };
  const emoji = emojiCountry(text);
  if (emoji) return { code: emoji, source: 'emoji' };
  const named = nameCountry(text);
  if (named) return { code: named, source: 'name' };
  const iso = isoCountry(text);
  if (iso) return { code: iso, source: 'iso' };
  return { code: '', source: '' };
}

export function bestPing(nodes) {
  const values = nodes.map((node) => node.ping).filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

// Groups keep the provider order inside a country and put the fastest country
// first; the unknown bucket is always last.
export function groupByCountry(nodes, language = 'ru') {
  const groups = new Map();
  for (const node of nodes) {
    const code = countryByCode(node.countryCode) ? node.countryCode : '';
    const key = code || 'unknown';
    if (!groups.has(key)) groups.set(key, { code, name: code ? countryLabel(code, language) : '', nodes: [] });
    groups.get(key).nodes.push(node);
  }
  const list = [...groups.values()].map((group) => ({ ...group, count: group.nodes.length, ping: bestPing(group.nodes) }));
  list.sort((a, b) => {
    if (!a.code !== !b.code) return a.code ? -1 : 1;
    if (a.ping !== b.ping) { if (a.ping === null) return 1; if (b.ping === null) return -1; return a.ping - b.ping; }
    return a.name.localeCompare(b.name, language);
  });
  return list;
}
