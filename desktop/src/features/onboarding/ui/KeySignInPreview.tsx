import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import { StyledQrCode } from "@/shared/ui/styled-qr-code";
import { NostrKeyImportForm } from "./NostrKeyImportForm";
import { ONBOARDING_INK_ICON_CLASS } from "./OnboardingChrome";
import { OnboardingPreviewStep } from "./OnboardingPreviewShell";
import { OnboardingSlideTransition } from "./OnboardingSlideTransition";

export function KeySignInPreview({
  onBack,
  onContinue,
  total,
}: {
  onBack: () => void;
  onContinue: () => void;
  total: number;
}) {
  const [keyImportDialog, setKeyImportDialog] = React.useState<
    "backup" | "phone" | null
  >(null);

  return (
    <OnboardingPreviewStep
      onBack={onBack}
      testId="onboarding-preview-sign-in-key"
      total={total}
    >
      <OnboardingSlideTransition
        className="flex min-h-[calc(100dvh-13.25rem)] w-full max-w-[837px] flex-col items-center text-center"
        transitionKey="preview-sign-in-key"
      >
        <h1 className="text-title font-normal text-foreground">
          Enter your private key
        </h1>
        <div className="mt-5 max-w-[440px] text-sm leading-6 text-foreground/80">
          <p>
            Paste your private key to sign in to Buzz. You can also use a{" "}
            <button
              className="rounded-sm font-medium underline decoration-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              data-testid="nostr-import-file-button"
              onClick={() => setKeyImportDialog("backup")}
              type="button"
            >
              backup file
            </button>
            , or{" "}
            <button
              className="rounded-sm font-medium underline decoration-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              data-testid="nostr-import-phone-link"
              onClick={() => setKeyImportDialog("phone")}
              type="button"
            >
              recover from your phone
            </button>
            .
          </p>
        </div>
        <div className="buzz-onboarding-key-import-position w-full">
          <NostrKeyImportForm
            onBack={onBack}
            onImport={async () => onContinue()}
            previewMode
            showBack={false}
            variant="spotlight"
          />
        </div>
        <Dialog
          onOpenChange={(open) => {
            if (!open) setKeyImportDialog(null);
          }}
          open={keyImportDialog === "backup"}
        >
          <DialogContent
            className="buzz-onboarding-neutral-theme max-w-[47.5rem] -translate-y-5"
            closeButtonClassName={ONBOARDING_INK_ICON_CLASS}
            data-system-color-scheme="light"
            data-testid="backup-recovery-dialog"
            surface="textured"
          >
            <div className="mx-auto w-full max-w-[35rem] pb-6 pt-10 text-center max-sm:pb-4 max-sm:pt-6">
              <DialogTitle className="text-balance px-8 text-3xl font-normal text-foreground">
                Restore from a backup file
              </DialogTitle>
              <DialogDescription className="mx-auto mt-4 max-w-[28rem] text-sm leading-6 text-foreground/80">
                Choose the encrypted backup file you saved from Buzz.
              </DialogDescription>
              <NostrKeyImportForm
                footerMode="inline"
                mode="backup"
                onBack={() => setKeyImportDialog(null)}
                onImport={async () => {
                  setKeyImportDialog(null);
                  onContinue();
                }}
                previewMode
                showBack={false}
                variant="spotlight"
              />
            </div>
          </DialogContent>
        </Dialog>
        <Dialog
          onOpenChange={(open) => {
            if (!open) setKeyImportDialog(null);
          }}
          open={keyImportDialog === "phone"}
        >
          <DialogContent
            className="buzz-onboarding-neutral-theme max-w-[47.5rem] -translate-y-5"
            closeButtonClassName={ONBOARDING_INK_ICON_CLASS}
            data-system-color-scheme="light"
            data-testid="phone-recovery-dialog"
            surface="textured"
          >
            <div className="mx-auto flex w-full max-w-[35rem] flex-col items-center pb-10 pt-10 text-center">
              <DialogTitle className="text-balance px-8 text-3xl font-normal text-foreground">
                Scan to sign in
              </DialogTitle>
              <DialogDescription className="mt-4 text-sm leading-6 text-foreground/80">
                Scan this code with a device where you’re currently signed in to
                Buzz.
              </DialogDescription>
              <div className="mt-6 flex size-[290px] items-center justify-center rounded-xl border border-border/70 bg-white p-6">
                <StyledQrCode
                  centerImageSrc="/app-icon@2x.png"
                  size={240}
                  title="Preview identity recovery QR code"
                  value="buzz-pair://preview-identity-recovery"
                />
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}
