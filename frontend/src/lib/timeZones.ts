/** 时区偏好默认值：跟随当前设备/浏览器系统时区。 */
export const DEFAULT_TIME_ZONE_PREFERENCE = "auto";

interface CuratedTimeZoneMeta {
  id: string;
  zh: string;
  en: string;
}

const CURATED_TIME_ZONES: readonly CuratedTimeZoneMeta[] = [
  { id: "UTC", zh: "世界协调时间 UTC", en: "Coordinated Universal Time (UTC)" },
  { id: "Asia/Shanghai", zh: "北京 / 上海（中国标准时间）", en: "Beijing / Shanghai (China)" },
  { id: "Asia/Hong_Kong", zh: "香港", en: "Hong Kong" },
  { id: "Asia/Taipei", zh: "台北", en: "Taipei" },
  { id: "Asia/Tokyo", zh: "东京（日本）", en: "Tokyo (Japan)" },
  { id: "Asia/Seoul", zh: "首尔（韩国）", en: "Seoul (Korea)" },
  { id: "Asia/Singapore", zh: "新加坡", en: "Singapore" },
  { id: "Asia/Bangkok", zh: "曼谷 / 河内", en: "Bangkok / Hanoi" },
  { id: "Asia/Jakarta", zh: "雅加达", en: "Jakarta" },
  { id: "Asia/Kolkata", zh: "新德里 / 孟买（印度）", en: "New Delhi / Mumbai (India)" },
  { id: "Asia/Dubai", zh: "迪拜", en: "Dubai" },
  { id: "Asia/Riyadh", zh: "利雅得", en: "Riyadh" },
  { id: "Asia/Tehran", zh: "德黑兰", en: "Tehran" },
  { id: "Asia/Almaty", zh: "阿拉木图", en: "Almaty" },
  { id: "Australia/Sydney", zh: "悉尼", en: "Sydney" },
  { id: "Australia/Melbourne", zh: "墨尔本", en: "Melbourne" },
  { id: "Australia/Perth", zh: "珀斯", en: "Perth" },
  { id: "Pacific/Auckland", zh: "奥克兰", en: "Auckland" },
  { id: "Pacific/Honolulu", zh: "檀香山（夏威夷）", en: "Honolulu (Hawaii)" },
  { id: "America/Anchorage", zh: "安克雷奇（阿拉斯加）", en: "Anchorage (Alaska)" },
  { id: "America/Los_Angeles", zh: "洛杉矶（美国西部）", en: "Los Angeles (US Pacific)" },
  { id: "America/Vancouver", zh: "温哥华", en: "Vancouver" },
  { id: "America/Denver", zh: "丹佛（美国山地）", en: "Denver (US Mountain)" },
  { id: "America/Chicago", zh: "芝加哥（美国中部）", en: "Chicago (US Central)" },
  { id: "America/Mexico_City", zh: "墨西哥城", en: "Mexico City" },
  { id: "America/New_York", zh: "纽约（美国东部）", en: "New York (US Eastern)" },
  { id: "America/Toronto", zh: "多伦多", en: "Toronto" },
  { id: "America/Sao_Paulo", zh: "圣保罗", en: "Sao Paulo" },
  { id: "America/Argentina/Buenos_Aires", zh: "布宜诺斯艾利斯", en: "Buenos Aires" },
  { id: "Europe/London", zh: "伦敦", en: "London" },
  { id: "Europe/Dublin", zh: "都柏林", en: "Dublin" },
  { id: "Europe/Paris", zh: "巴黎", en: "Paris" },
  { id: "Europe/Berlin", zh: "柏林", en: "Berlin" },
  { id: "Europe/Zurich", zh: "苏黎世", en: "Zurich" },
  { id: "Europe/Amsterdam", zh: "阿姆斯特丹", en: "Amsterdam" },
  { id: "Europe/Madrid", zh: "马德里", en: "Madrid" },
  { id: "Europe/Rome", zh: "罗马", en: "Rome" },
  { id: "Europe/Stockholm", zh: "斯德哥尔摩", en: "Stockholm" },
  { id: "Europe/Athens", zh: "雅典", en: "Athens" },
  { id: "Europe/Istanbul", zh: "伊斯坦布尔", en: "Istanbul" },
  { id: "Europe/Moscow", zh: "莫斯科", en: "Moscow" },
  { id: "Africa/Cairo", zh: "开罗", en: "Cairo" },
  { id: "Africa/Johannesburg", zh: "约翰内斯堡", en: "Johannesburg" },
  { id: "Africa/Lagos", zh: "拉各斯", en: "Lagos" },
];

const CURATED_BY_ID = new Map(CURATED_TIME_ZONES.map((item) => [item.id, item]));

export function canonicalizeIanaTimeZone(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed !== value ||
    trimmed.length > 100 ||
    /\s/.test(trimmed) ||
    (trimmed !== "UTC" && !trimmed.includes("/"))
  ) {
    return null;
  }
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    return resolved || null;
  } catch {
    return null;
  }
}

export function isValidIanaTimeZone(value: string): boolean {
  return canonicalizeIanaTimeZone(value) !== null;
}

export function normalizeTimeZonePreference(
  value: unknown,
  fallback: string = DEFAULT_TIME_ZONE_PREFERENCE,
): string {
  if (typeof value !== "string") return fallback;
  if (value === DEFAULT_TIME_ZONE_PREFERENCE) return DEFAULT_TIME_ZONE_PREFERENCE;
  return canonicalizeIanaTimeZone(value) ?? fallback;
}

export function getSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function resolveEffectiveTimeZone(preference: string | null | undefined): string {
  const normalized = normalizeTimeZonePreference(preference, DEFAULT_TIME_ZONE_PREFERENCE);
  if (normalized === DEFAULT_TIME_ZONE_PREFERENCE) {
    return getSystemTimeZone();
  }
  return normalized;
}

/**
 * 计算给定 UTC 毫秒时间戳在指定 IANA 时区下的 `Date.getTimezoneOffset()` 语义偏移（分钟，`UTC - local`）。
 * 例：`Asia/Shanghai` 返回 `-480`，`America/New_York` 冬令时返回 `+300`。
 */
export function getTimeZoneOffsetMinutesAt(utcMs: number, timeZone: string): number {
  const date = new Date(utcMs);
  if (!Number.isFinite(date.getTime())) return 0;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(date);
    const map: Record<string, number> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = Number(part.value);
    }
    const asUtcMs = Date.UTC(
      map.year,
      map.month - 1,
      map.day,
      map.hour === 24 ? 0 : map.hour,
      map.minute,
      map.second,
    );
    const msPart = utcMs >= 0 ? utcMs % 1000 : ((utcMs % 1000) + 1000) % 1000;
    const secAlignedUtcMs = utcMs - msPart;
    return Math.round((secAlignedUtcMs - asUtcMs) / 60_000);
  } catch {
    return date.getTimezoneOffset();
  }
}

export function formatUtcOffsetLabel(timeZone: string, date = new Date()): string {
  const offsetMinutes = getTimeZoneOffsetMinutesAt(date.getTime(), timeZone);
  const eastMinutes = -offsetMinutes;
  const sign = eastMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(eastMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

export function formatTimeZoneFriendlyName(
  timeZone: string,
  language: string,
): string {
  const isZh = language.toLowerCase().startsWith("zh");
  const curated = CURATED_BY_ID.get(timeZone);
  if (curated) {
    return isZh ? curated.zh : curated.en;
  }
  return timeZone;
}

export interface TimeZoneSelectOption {
  value: string;
  label: string;
}

export function getTimeZoneSelectOptions({
  language,
  currentValue,
  now = new Date(),
  autoLabelPrefix,
}: {
  language: string;
  currentValue?: string;
  now?: Date;
  autoLabelPrefix?: string;
}): TimeZoneSelectOption[] {
  const isZh = language.toLowerCase().startsWith("zh");
  const systemTz = getSystemTimeZone();
  const systemOffset = formatUtcOffsetLabel(systemTz, now);
  const autoText = autoLabelPrefix
    ? `${autoLabelPrefix}（${systemTz} · ${systemOffset}）`
    : isZh
      ? `跟随系统（${systemTz} · ${systemOffset}）`
      : `Follow system (${systemTz} · ${systemOffset})`;

  const options: TimeZoneSelectOption[] = [
    {
      value: DEFAULT_TIME_ZONE_PREFERENCE,
      label: isZh ? autoText : `${autoLabelPrefix || "Follow system"} (${systemTz} · ${systemOffset})`,
    },
  ];

  const seen = new Set<string>([DEFAULT_TIME_ZONE_PREFERENCE]);
  const addZone = (zoneId: string) => {
    const canonical = canonicalizeIanaTimeZone(zoneId);
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    const offset = formatUtcOffsetLabel(canonical, now);
    const curated = CURATED_BY_ID.get(canonical);
    const displayName = curated
      ? (isZh ? curated.zh : curated.en)
      : canonical;
    options.push({
      value: canonical,
      label: curated
        ? `${offset} · ${displayName} (${canonical})`
        : `${offset} · ${displayName}`,
    });
  };

  for (const item of CURATED_TIME_ZONES) {
    addZone(item.id);
  }

  const normalizedCurrent = normalizeTimeZonePreference(currentValue, DEFAULT_TIME_ZONE_PREFERENCE);
  if (normalizedCurrent !== DEFAULT_TIME_ZONE_PREFERENCE) {
    addZone(normalizedCurrent);
  }

  const intlWithSupported = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intlWithSupported.supportedValuesOf === "function") {
    try {
      const supported = intlWithSupported.supportedValuesOf("timeZone");
      for (const zoneId of supported) {
        addZone(zoneId);
      }
    } catch {
      // 旧版运行环境不支持 supportedValuesOf("timeZone") 时保留常用时区列表。
    }
  }

  return options;
}

export function formatTimeZonePreview(
  preference: string | null | undefined,
  locale: string,
  now = new Date(),
): {
  isAuto: boolean;
  effectiveTimeZone: string;
  offsetLabel: string;
  formattedTime: string;
} {
  const normalized = normalizeTimeZonePreference(preference, DEFAULT_TIME_ZONE_PREFERENCE);
  const effectiveTimeZone = normalized === DEFAULT_TIME_ZONE_PREFERENCE
    ? getSystemTimeZone()
    : normalized;
  const offsetLabel = formatUtcOffsetLabel(effectiveTimeZone, now);
  let formattedTime = "";
  try {
    formattedTime = now.toLocaleString(locale, {
      timeZone: effectiveTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    formattedTime = now.toLocaleString(locale);
  }
  return {
    isAuto: normalized === DEFAULT_TIME_ZONE_PREFERENCE,
    effectiveTimeZone,
    offsetLabel,
    formattedTime,
  };
}
