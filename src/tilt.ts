// Gyro look-around: how far the phone has turned (alpha, yaw) and tipped (beta, pitch) since tilt was turned on,
// as a look offset (−1…1 each, past ±1 is clamped by the renderer). Not gamma: that is rolling the phone
// sideways, and it jumps and flips sign as a phone held upright passes vertical, which made the view stall or
// swing the wrong way.

export type Orientation = { alpha: number; beta: number };

/** Degrees of turn for the full width of the view. */
const RANGE = 22;

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** screenAngle: screen.orientation.angle (0 portrait, 90/270 landscape, 180 upside down). */
export function lookFromTilt(base: Orientation, now: Orientation, screenAngle: number): { x: number; y: number } {
  // Alpha grows turning left (counter-clockwise from above), and turning left should show what is to the left.
  const x = -wrap(now.alpha - base.alpha) / RANGE;
  // Pitch is only clean in portrait; in landscape the view pans sideways only.
  const portrait = screenAngle === 0 || screenAngle === 180;
  const y = portrait ? (-(screenAngle === 180 ? -1 : 1) * (now.beta - base.beta)) / RANGE : 0;
  return { x, y };
}
