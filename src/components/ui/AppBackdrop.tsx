// The slowly rotating, drifting contour texture and sliding dot grid behind every page, tinted with the accent (docs/specs/landing-look.md). Still under reduced motion.
export function AppBackdrop() {
  return (
    <div aria-hidden="true" className="app-backdrop">
      <div className="app-backdrop-contour-rot">
        <div className="app-backdrop-contour" />
      </div>
      <div className="app-backdrop-dots" />
    </div>
  );
}
