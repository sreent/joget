import { ICONS, type IconName } from '@platform/design/icons';

export type { IconName };

/** One of Ocean's icons, drawn inline in currentColor, as Ocean's pages draw them. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className ? `icon ${className}` : 'icon'}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Ocean's icons are fixed markup in the bundle, never text from people
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
