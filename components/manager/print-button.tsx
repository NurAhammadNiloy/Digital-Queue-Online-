"use client";

type Props = { href?: string };

export function PrintButton({ href }: Props) {
  function printPoster() {
    if (!href) {
      window.print();
      return;
    }
    const popup = window.open(href, "digital-queue-print");
    if (!popup) return;
    popup.addEventListener("load", () => {
      popup.focus();
      popup.print();
    }, { once: true });
  }

  return <button type="button" onClick={printPoster} className="btn print:hidden">Print QR</button>;
}
