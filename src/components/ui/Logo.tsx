interface Props {
  className?: string;
  alt?: string;
}

// The heartbeat logo (docs/specs/landing-look.md): the waveform beats and the pin pulses with it.
// People who ask for reduced motion get the still logo, chosen by the browser with no script.
export function Logo({ className = 'h-8 w-8', alt = 'LiveArchive' }: Props) {
  return (
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcSet="/logo.svg" />
      <img src="/logo-heartbeat.svg" alt={alt} className={className} />
    </picture>
  );
}
