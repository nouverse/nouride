/**
 * A formula in the line of a paragraph, `$..$` or `\(..\)`, typeset once the formulas' chunk is here
 * (`viewers/math.tsx`). Until then, and when KaTeX cannot read it, it is the text as written, dollars and all.
 */

import { useEffect, useState } from "react";

type MathModule = typeof import("@/commons/components/ui/viewers/math");

let arriving: Promise<MathModule> | null = null;
let arrived: MathModule | null = null;

export function InlineMath({ tex, written }: { tex: string; /** The formula as it was written, with its marks. */ written: string }) {
  const [here, setHere] = useState(arrived);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (here) return;
    let mounted = true;
    arriving ??= import("@/commons/components/ui/viewers/math");
    arriving.then(
      (module) => {
        arrived = module;
        if (mounted) setHere(module);
      },
      // It did not load: the text stays as written, and the next formula asks again.
      () => {
        arriving = null;
      },
    );
    return () => {
      mounted = false;
    };
  }, [here]);
  if (!here || failed === tex) return <>{written}</>;
  return <here.Formula tex={tex} display={false} onFail={() => setFailed(tex)} />;
}
