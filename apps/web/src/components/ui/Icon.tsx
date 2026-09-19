import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";

type IconProps = ComponentProps<typeof HugeiconsIcon>;

export const Icon = ({
  size = 15,
  color = "currentColor",
  strokeWidth = 1.8,
  ...props
}: IconProps) => (
  <HugeiconsIcon
    size={size}
    color={color}
    strokeWidth={strokeWidth}
    {...props}
  />
);
