/**
 * Nouride Home, the app that runs Nouride on a phone or a computer, shows this dashboard in its own window (a WebView)
 * and marks the window's user agent. Inside it the dashboard offers two ways out of a page, as two links the app
 * catches (its `LinkPolicy`); neither is ever a page.
 *
 * - Back, the chevron in a phone's header: one page back each time, as the phone's own Back does, and at the first
 *   page the app asks whether to go back to Nouride Home.
 * - "Back to Nouride Home", the menu's row, the folded menu's tile and the button on the pages that have no header
 *   (`HomeAppLeave`): the app asks at once, whatever the page. After a while of moving about, paging back took as many
 *   presses as pages.
 */
const HOME_APP_MARK = "NourideHome/";

/** "Back to Nouride Home": the app asks at once whether to leave the dashboard. */
export const HOME_APP_BACK = "nouridehome://home";

/** Back: the app treats it as its system Back, a page back, and asks only at the first page. */
const HOME_APP_PAGE_BACK = "nouridehome://back";

/**
 * The link the header's Back sends, by what the app says it catches: the number after its mark. An app that says 1
 * knows `nouridehome://home` alone, as its system Back, and opens any other link outside itself, where nothing takes
 * it: sent `nouridehome://back`, its header's Back did nothing at all. Apps installed before the two links were told
 * apart say 1, and are not updated with the daemon.
 */
export function homeAppPageBack(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const says = Number(new RegExp(`${HOME_APP_MARK}(\\d+)`).exec(userAgent)?.[1] ?? 0);
  return says >= 2 ? HOME_APP_PAGE_BACK : HOME_APP_BACK;
}

export function inHomeApp(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return userAgent.includes(HOME_APP_MARK);
}
