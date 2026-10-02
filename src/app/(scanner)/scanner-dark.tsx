"use client";

import { useLayoutEffect } from "react";

/**
 * Puts the scanner's dark mode on `<html>` (spec/v3.md §32.2).
 *
 * The surface layout's wrapper `div` is dark, but drawers, dialogs, menus and
 * toasts portal to `<body>`, outside it — so the attendee sheet opened as a
 * white panel at arm's length in a dim foyer. On `<html>` every portal is
 * inside the dark scope. Taken off again as the scanner unmounts, so a
 * client-side navigation never carries it to another surface.
 */
export function ScannerDark() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    const scheme = root.style.colorScheme;
    root.classList.add("dark");
    root.style.colorScheme = "dark";
    return () => {
      if (!hadDark) root.classList.remove("dark");
      root.style.colorScheme = scheme;
    };
  }, []);
  return null;
}
