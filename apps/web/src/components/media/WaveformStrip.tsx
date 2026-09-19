type WaveformStripProps = {
  points: number[];
  width: number | string;
  height: number;
  progress?: number;
  baseColor?: string;
  progressColor?: string;
};

export const WaveformStrip = ({
  points,
  width,
  height,
  progress = 0,
  baseColor = "var(--color-waveform-idle)",
  progressColor = "var(--color-waveform-played)",
}: WaveformStripProps) => {
  const normalizedProgress = Math.max(0, Math.min(1, progress));

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${points.length} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {points.map((point, index) => {
        const amplitude = Math.max(0.08, Math.min(1, point));
        const barHeight = amplitude * height;
        const y = (height - barHeight) / 2;
        const isPlayed = (index + 1) / points.length <= normalizedProgress;

        return (
          <rect
            key={index}
            x={index + 0.12}
            y={y}
            width={0.76}
            height={barHeight}
            rx={0.34}
            fill={isPlayed ? progressColor : baseColor}
          />
        );
      })}
    </svg>
  );
};
