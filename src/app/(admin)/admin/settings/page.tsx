import type { Metadata } from 'next';
import { ModulePlaceholder } from '../placeholder';
import { SETTINGS_ITEM } from '../nav';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <ModulePlaceholder
      title={SETTINGS_ITEM.label}
      description={SETTINGS_ITEM.description}
      module={SETTINGS_ITEM.module}
    />
  );
}
