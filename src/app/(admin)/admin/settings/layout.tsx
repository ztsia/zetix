import { SettingsTabs } from '../area-tabs';
import { SETTINGS_TABS } from '../nav';

/**
 * Settings: the system defaults and the console's people and roles, as one
 * global area with two screens (spec/v3.md §29.1).
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SettingsTabs tabs={SETTINGS_TABS} />
      {children}
    </>
  );
}
