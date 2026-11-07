/**
 * Nouride Home, the Android app that runs Nouride on the phone, shows this dashboard in a WebView and marks the
 * WebView's user agent. Inside it, the header offers a way back to the app's own screen: the phone's back gesture walks
 * the dashboard's history like a browser's, and once took a person from the dashboard back to the setup wizard.
 * The app catches the link and closes the dashboard; it is never a page.
 */
const HOME_APP_MARK = "NourideHome/";

/** What the app catches (its `LinkPolicy`). */
export const HOME_APP_BACK = "nouridehome://home";

export function inHomeApp(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return userAgent.includes(HOME_APP_MARK);
}
