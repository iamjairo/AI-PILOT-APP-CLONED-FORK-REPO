import type { LucideProps } from 'lucide-react';
import * as icons from 'lucide-react';

interface IconProps extends Omit<LucideProps, 'ref'> {
  // Accept any string: icon names often come from dynamic data (commands,
  // menu items). Unknown names are handled at runtime below.
  name: string;
}

export function Icon({ name, size = 16, ...props }: IconProps) {
  const LucideIcon = icons[name as keyof typeof icons] as
    | React.ComponentType<LucideProps>
    | undefined;
  if (!LucideIcon) {
    console.warn(`Icon "${name}" not found in lucide-react`);
    return null;
  }
  return <LucideIcon size={size} {...props} />;
}
