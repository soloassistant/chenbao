/**
 * 旅行目的地天气（真实数据，Open-Meteo 免费接口，无需 key）。
 *
 * 只取未来 7 天的日最高/最低温与天气代码；取不到就返回 null，
 * 页面显示「天气暂不可用」，绝不填假数字。
 */
export interface TravelWeatherDay {
  date: string;
  max: number;
  min: number;
  code: number;
}

interface OpenMeteoDaily {
  time?: string[];
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  weather_code?: number[];
}

export async function fetchTravelWeather(lat: number, lon: number): Promise<TravelWeatherDay[] | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=7&timezone=auto';
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { daily?: OpenMeteoDaily };
    const d = json?.daily;
    if (!d || !Array.isArray(d.time) || d.time.length === 0) return null;
    const out: TravelWeatherDay[] = [];
    for (let i = 0; i < d.time.length; i += 1) {
      const max = d.temperature_2m_max?.[i];
      const min = d.temperature_2m_min?.[i];
      if (typeof max !== 'number' || typeof min !== 'number') continue;
      out.push({ date: d.time[i], max: Math.round(max), min: Math.round(min), code: d.weather_code?.[i] ?? 0 });
    }
    return out.length > 0 ? out : null;
  } catch (err) {
    console.warn('[travel] weather failed:', err);
    return null;
  }
}
