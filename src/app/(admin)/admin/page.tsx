import { redirect } from 'next/navigation';

/** `/admin` has no screen of its own — the console starts at the concert list. */
export default function AdminIndexPage() {
  redirect('/admin/concerts');
}
