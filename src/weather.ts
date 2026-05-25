// ─── Night Shift by Does News | doesnews.com ───────────────────────────────
// Tomorrow.io weather API integration
// Fetches forecasts for major US metros — tomorrow and next 2 days ONLY.
// Today's weather is intentionally excluded (Night Shift is an evening show).

import type { CityForecast, DayForecast, WeatherBundle } from "./types";

// Major US metros to cover. Coordinates are (lat, lon).
const METROS: { city: string; state: string; lat: number; lon: number }[] = [
  { city: "New York",     state: "NY", lat: 40.7128,  lon: -74.006  },
  { city: "Boston",       state: "MA", lat: 42.3601,  lon: -71.0589 },
  { city: "Washington",   state: "DC", lat: 38.9072,  lon: -77.0369 },
  { city: "Atlanta",      state: "GA", lat: 33.749,   lon: -84.388  },
  { city: "Miami",        state: "FL", lat: 25.7617,  lon: -80.1918 },
  { city: "Chicago",      state: "IL", lat: 41.8781,  lon: -87.6298 },
  { city: "Houston",      state: "TX", lat: 29.7604,  lon: -95.3698 },
  { city: "Dallas",       state: "TX", lat: 32.7767,  lon: -96.797  },
  { city: "Denver",       state: "CO", lat: 39.7392,  lon: -104.9903},
  { city: "Phoenix",      state: "AZ", lat: 33.4484,  lon: -112.074 },
  { city: "Los Angeles",  state: "CA", lat: 34.0522,  lon: -118.2437},
  { city: "Seattle",      state: "WA", lat: 47.6062,  lon: -122.3321},
];

// Tomorrow.io weather code → human-readable description
const WEATHER_CODE_MAP: Record<number, string> = {
  1000: "Clear and sunny",
  1001: "Cloudy",
  1100: "Mostly clear",
  1101: "Partly cloudy",
  1102: "Mostly cloudy",
  2000: "Foggy",
  2100: "Light fog",
  3000: "Light wind",
  3001: "Windy",
  3002: "Strong winds",
  4000: "Drizzle",
  4001: "Rain",
  4200: "Light rain",
  4201: "Heavy rain",
  5000: "Snow",
  5001: "Flurries",
  5100: "Light snow",
  5101: "Heavy snow",
  6000: "Freezing drizzle",
  6001: "Freezing rain",
  6200: "Light freezing rain",
  6201: "Heavy freezing rain",
  7000: "Ice pellets",
  7101: "Heavy ice pellets",
  7102: "Light ice pellets",
  8000: "Thunderstorms",
};

function weatherCodeToConditions(code: number): string {
  return WEATHER_CODE_MAP[code] ?? "Variable conditions";
}

function formatForecastDate(isoDateString: string): string {
  // e.g. "2026-05-26T06:00:00Z" → "Tuesday, May 26"
  const d = new Date(isoDateString);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

interface TomorrowDailyValues {
  temperatureMax?: number;
  temperatureMin?: number;
  temperatureApparentMax?: number;
  temperatureApparentMin?: number;
  weatherCodeMax?: number;
  precipitationProbabilityAvg?: number;
  windSpeedAvg?: number;
  windGustMax?: number;
}

interface TomorrowDailyItem {
  time: string;
  values: TomorrowDailyValues;
}

interface TomorrowForecastResponse {
  timelines?: {
    daily?: TomorrowDailyItem[];
  };
  code?: number;
  type?: string;
  message?: string;
}

function parseDayForecast(item: TomorrowDailyItem): DayForecast {
  const v = item.values;
  return {
    date: formatForecastDate(item.time),
    high: Math.round(v.temperatureMax ?? v.temperatureApparentMax ?? 0),
    low: Math.round(v.temperatureMin ?? v.temperatureApparentMin ?? 0),
    conditions: weatherCodeToConditions(v.weatherCodeMax ?? 1000),
    precipitationProbability: Math.round(v.precipitationProbabilityAvg ?? 0),
    windSpeed: Math.round(v.windSpeedAvg ?? 0),
    windGust: Math.round(v.windGustMax ?? 0),
  };
}

async function fetchCityForecast(
  city: string,
  state: string,
  lat: number,
  lon: number,
  apiKey: string
): Promise<CityForecast> {
  const url = new URL("https://api.tomorrow.io/v4/weather/forecast");
  url.searchParams.set("location", `${lat},${lon}`);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("units", "imperial");
  url.searchParams.set("timesteps", "1d");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    // 10-second timeout for each city request
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Tomorrow.io ${response.status} for ${city}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as TomorrowForecastResponse;
  const daily = data.timelines?.daily;

  if (!daily || daily.length < 3) {
    throw new Error(`Tomorrow.io returned insufficient daily data for ${city}`);
  }

  // daily[0] = TODAY — intentionally skipped (Night Shift is an evening show)
  // daily[1] = tomorrow
  // daily[2] = day after tomorrow
  // daily[3] = three days out
  return {
    city,
    state,
    tomorrow:    parseDayForecast(daily[1]),
    inTwoDays:   parseDayForecast(daily[2]),
    inThreeDays: daily[3] ? parseDayForecast(daily[3]) : parseDayForecast(daily[2]),
  };
}

export async function fetchAllForecasts(apiKey: string): Promise<WeatherBundle> {
  const results = await Promise.allSettled(
    METROS.map((m) => fetchCityForecast(m.city, m.state, m.lat, m.lon, apiKey))
  );

  const forecasts: CityForecast[] = [];
  const fetchErrors: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      forecasts.push(result.value);
    } else {
      const metro = METROS[i];
      fetchErrors.push(`${metro.city}, ${metro.state}: ${result.reason}`);
      console.error(`[weather] Failed to fetch ${metro.city}:`, result.reason);
    }
  }

  return {
    asOf: new Date().toISOString(),
    forecasts,
    fetchErrors,
  };
}

// Format the weather bundle into a structured text block for the AI prompt.
export function formatWeatherForPrompt(bundle: WeatherBundle): string {
  if (bundle.forecasts.length === 0) {
    return "WEATHER DATA: No forecast data available. Acknowledge briefly and move on.";
  }

  const lines: string[] = [
    "WEATHER FORECAST DATA (provided by Tomorrow.io — use this directly in the forecast section):",
    "NOTE: Do NOT include today's weather. The show airs at night; tonight's weather is behind us.",
    "Cover tomorrow and the following 2 days ONLY.",
    "",
  ];

  for (const city of bundle.forecasts) {
    lines.push(`${city.city}, ${city.state}:`);

    const t = city.tomorrow;
    lines.push(
      `  Tomorrow (${t.date}): High ${t.high}°F / Low ${t.low}°F — ${t.conditions}` +
        ` | Rain chance: ${t.precipitationProbability}%` +
        ` | Wind: ${t.windSpeed} mph (gusts to ${t.windGust} mph)`
    );

    const d2 = city.inTwoDays;
    lines.push(
      `  ${d2.date}: High ${d2.high}°F / Low ${d2.low}°F — ${d2.conditions}` +
        ` | Rain chance: ${d2.precipitationProbability}%`
    );

    const d3 = city.inThreeDays;
    lines.push(
      `  ${d3.date}: High ${d3.high}°F / Low ${d3.low}°F — ${d3.conditions}` +
        ` | Rain chance: ${d3.precipitationProbability}%`
    );

    lines.push("");
  }

  if (bundle.fetchErrors.length > 0) {
    lines.push("Cities with data errors (skip or note briefly):");
    bundle.fetchErrors.forEach((e) => lines.push(`  - ${e}`));
    lines.push("");
  }

  return lines.join("\n");
}
