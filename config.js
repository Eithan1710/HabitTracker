/* Fill in these two values from Supabase: Project Settings -> API.
 *
 * SUPABASE_URL       e.g. "https://abcdefghijkl.supabase.co"
 * SUPABASE_ANON_KEY  the "anon" (publishable) key. It is public by design:
 *                    Row Level Security (supabase.sql) is what protects your data.
 *                    NEVER put the "service_role" key here.
 *
 * VAPID_PUBLIC_KEY   public key for the daily 21:00 push reminder (public by design;
 *                    the matching private key lives only on the server).
 *
 * While these are empty the app still works: taps are saved on the device only.
 */
window.HABITS_CONFIG = {
  SUPABASE_URL: 'https://kfnbtdgdwnzbqvbyvzmt.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_cLH9y_w9KjD1TRjOpCZsOw_gX1GT4lI',
  VAPID_PUBLIC_KEY: 'BGn1JoiK09UfjmwSR-l0hjh2YhKXLhvLh1jKS2bHec2Am_DnEEb2DSCmZwRcVh1B4gcf9ciYQk0wqykRZk7uEUk'
};
