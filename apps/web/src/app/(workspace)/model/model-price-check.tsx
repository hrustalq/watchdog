"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PriceCheck } from "@/lib/model-list";
import { applyPricesAction, checkPricesAction } from "./actions";
import { modelListFailureMessage } from "./model-list-words";

/** A price as the line shows it: a number, or the word for one that isn't set. */
const price = (value: number | null) => (value === null ? "not set" : String(value));

/**
 * The saved model's **Check prices**: it re-reads the provider's metadata and shows what the row
 * holds beside what the provider says. Nothing is written until the user picks one, and then only
 * the model's own prices change (GitHub issue #489).
 */
export function ModelPriceCheck({ savedInput, savedOutput }: { savedInput: number | null; savedOutput: number | null }) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<PriceCheck | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  async function checkNow() {
    setChecking(true);
    setNotice(undefined);
    try {
      setCheck(await checkPricesAction());
    } catch {
      setCheck({ kind: "unavailable", reason: "request-failed" });
    } finally {
      setChecking(false);
    }
  }

  async function applyDetected(input: number, output: number) {
    setSaving(true);
    try {
      const result = await applyPricesAction({ inputPrice: String(input), outputPrice: String(output) });
      if ("saved" in result) {
        setNotice("Prices saved. Usage estimates this model from now on.");
        setCheck(null);
        router.refresh();
      } else {
        setNotice("Those prices weren't accepted. Enter them in the form below instead.");
      }
    } catch {
      setNotice("The prices weren't saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void checkNow()} disabled={checking || saving}>
          {checking ? "Checking…" : "Check prices"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Reads the provider&apos;s metadata. Nothing changes until you confirm.
        </p>
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {notice === undefined ? null : <p className="text-sm">{notice}</p>}
        {check === null ? null : (
          <CheckResult
            check={check}
            saved={{ input: savedInput, output: savedOutput }}
            saving={saving}
            onUse={(input, output) => void applyDetected(input, output)}
            onKeep={() => {
              setCheck(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** What one check found, in the words the card uses: the saved price, the detected one, and a way out. */
function CheckResult({
  check,
  saved,
  saving,
  onUse,
  onKeep,
}: {
  check: PriceCheck;
  saved: { input: number | null; output: number | null };
  saving: boolean;
  onUse: (input: number, output: number) => void;
  onKeep: () => void;
}) {
  switch (check.kind) {
    case "detected":
      return (
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-3">
          <p className="text-sm">
            Saved: <span className="text-data">{price(saved.input)}</span> in,{" "}
            <span className="text-data">{price(saved.output)}</span> out a million.
          </p>
          <p className="text-sm">
            {check.modelName} now says <span className="text-data">{check.inputPricePerMillion}</span> in,{" "}
            <span className="text-data">{check.outputPricePerMillion}</span> out a million.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onUse(check.inputPricePerMillion, check.outputPricePerMillion);
              }}
              disabled={saving}
            >
              {saving ? "Saving…" : "Use these prices"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onKeep} disabled={saving}>
              Keep mine
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Earlier calls keep the prices they recorded, so past months&apos; estimates don&apos;t change.
          </p>
        </div>
      );
    case "no-prices":
      return <p className="text-sm">This provider publishes no prices for {check.modelName}, so the fields stay yours.</p>;
    case "not-listed":
      return <p className="text-sm">The provider doesn&apos;t list {check.modelName} any more, so there is no price to read.</p>;
    case "unavailable":
      return <p className="text-sm">{modelListFailureMessage[check.reason]}</p>;
    case "no-model":
      return <p className="text-sm">There is no saved model to check.</p>;
  }
}
