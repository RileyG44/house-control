// Where the sun and the moon are, seen from the house: pure functions of a time and a place,
// so day and night are right with no network at all. The sun is NOAA's solar position
// (good to well under a degree); the moon a short series (a degree or so) and its phase.
// Angles in and out are degrees; a bearing is the compass direction, 0 north, 90 east.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const J2000 = 2451545;

const julian = (date) => date.getTime() / 86400000 + 2440587.5;
const wrap = (deg) => ((deg % 360) + 360) % 360;

/** The sun's { altitude, bearing } at `date` from `lat`, `lon`. */
export function sunPosition(date, lat, lon) {
  const jc = (julian(date) - J2000) / 36525;
  const L = wrap(280.46646 + jc * (36000.76983 + jc * 0.0003032));        // mean longitude
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);               // mean anomaly
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);          // orbit eccentricity
  const C = Math.sin(M * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * jc) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const lambda = L + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);        // apparent longitude
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);                     // obliquity
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  // The equation of time, in minutes: how far the sun runs ahead of the clock.
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime = 4 * DEG * (y * Math.sin(2 * L * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L * RAD)
    - 0.5 * y * y * Math.sin(4 * L * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const solar = (((minutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = solar / 4 < 0 ? solar / 4 + 180 : solar / 4 - 180;
  return horizon(lat, decl, hourAngle * RAD);
}

// Altitude and bearing of something at declination `decl` and hour angle `H` (radians).
function horizon(lat, decl, H) {
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
  // Measured from south, turning west; +180 makes it a compass bearing.
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi));
  return { altitude: alt * DEG + refraction(alt * DEG), bearing: wrap(az * DEG + 180) };
}

// The air lifts what is near the horizon by about half a degree.
function refraction(alt) {
  if (alt < -2) return 0;
  return 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * RAD) / 60;
}

// The moon's right ascension, declination (radians) and distance (km) `d` days after J2000.
function moonCoords(d) {
  const L = (218.316 + 13.176396 * d) * RAD;   // ecliptic longitude
  const M = (134.963 + 13.064993 * d) * RAD;   // mean anomaly
  const F = (93.272 + 13.229350 * d) * RAD;    // mean distance from the node
  const l = L + 6.289 * RAD * Math.sin(M);
  const b = 5.128 * RAD * Math.sin(F);
  const e = 23.4397 * RAD;
  return {
    ra: Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l)),
    dec: Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l)),
    dist: 385001 - 20905 * Math.cos(M),
  };
}

function sunCoords(d) {
  const M = (357.5291 + 0.98560028 * d) * RAD;
  const C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * RAD;
  const L = M + C + 102.9372 * RAD + Math.PI;
  const e = 23.4397 * RAD;
  return { ra: Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L)), dec: Math.asin(Math.sin(e) * Math.sin(L)) };
}

/**
 * The moon's { altitude, bearing, phase, lit } at `date` from `lat`, `lon`: `phase` 0 new,
 * 0.25 first quarter, 0.5 full, 0.75 last quarter; `lit` the fraction of its face in sunlight.
 */
export function moonPosition(date, lat, lon) {
  const d = julian(date) - J2000;
  const m = moonCoords(d);
  const sidereal = (280.16 + 360.9856235 * d) * RAD + lon * RAD;
  const pos = horizon(lat, m.dec, sidereal - m.ra);
  const s = sunCoords(d);
  const SUN_KM = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(SUN_KM * Math.sin(phi), m.dist - SUN_KM * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { ...pos, lit: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI };
}

/**
 * A direction in the sky as a unit vector in the plan's frame (x right, y up, z towards the
 * plan's bottom): the plan's -z points at compass bearing `planUp`, so bearing b lies at -z
 * turned clockwise (seen from above, as the plan is drawn) by b - planUp.
 */
export function planDirection(bearing, altitude, planUp = 0, out = { x: 0, y: 0, z: 0 }) {
  const turn = (bearing - planUp) * RAD;
  const alt = altitude * RAD;
  out.x = Math.cos(alt) * Math.sin(turn);
  out.y = Math.sin(alt);
  out.z = -Math.cos(alt) * Math.cos(turn);
  return out;
}

/** 0 at night (sun below -6°), 1 by day (above +6°), easing through twilight. */
export function daylight(altitude) {
  const t = Math.min(1, Math.max(0, (altitude + 6) / 12));
  return t * t * (3 - 2 * t);
}
