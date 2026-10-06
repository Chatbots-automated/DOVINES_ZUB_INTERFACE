"use client";

import * as React from "react";

export function PrintTrigger() {
  React.useEffect(() => {
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <button type="button" onClick={() => window.print()} className="no-print mb-4 rounded border px-3 py-1 text-[13px]">
      Spausdinti / išsaugoti PDF
    </button>
  );
}
