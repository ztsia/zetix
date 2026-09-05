import { notFound } from 'next/navigation';
import { ModulePlaceholder } from '../../../placeholder';
import { findNavItem } from '../../../nav';

export default function Page() {
  const item = findNavItem('notes');
  if (!item) notFound();
  return (
    <ModulePlaceholder
      title={item.label}
      description={item.description}
      module={item.module}
    />
  );
}
