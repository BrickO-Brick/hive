import type * as React from "react";

import {
  AuxiliaryPanel,
  AuxiliaryPanelBody,
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderGroup,
  AuxiliaryPanelTitle,
} from "@/shared/layout/AuxiliaryPanel";

export function IdleAuxiliaryPanel({
  canResetWidth,
  children,
  isFocusDrawer = false,
  isSinglePanelView,
  onClose,
  onResetWidth,
  onResizeStart,
  title,
  useSplitAuxiliaryPane,
  widthPx,
}: {
  canResetWidth: boolean;
  children: React.ReactNode;
  isFocusDrawer?: boolean;
  isSinglePanelView: boolean;
  onClose: () => void;
  onResetWidth: () => void;
  onResizeStart: React.PointerEventHandler<HTMLButtonElement>;
  title: string;
  useSplitAuxiliaryPane: boolean;
  widthPx: number;
}) {
  const split = useSplitAuxiliaryPane && !isFocusDrawer;
  return (
    <AuxiliaryPanel
      canResetWidth={canResetWidth}
      enterMotion={!isFocusDrawer}
      isSinglePanelView={
        isFocusDrawer ? true : split ? false : isSinglePanelView
      }
      layout={split ? "split" : "standalone"}
      onClose={onClose}
      onResetWidth={onResetWidth}
      onResizeStart={onResizeStart}
      resizeHandleAriaLabel="Resize panel"
      resizeHandleTestId="idle-auxiliary-resize-handle"
      testId="idle-auxiliary-panel"
      transparentChrome={split}
      widthPx={widthPx}
      header={
        <AuxiliaryPanelHeader backdrop={isFocusDrawer} transparent={split}>
          <AuxiliaryPanelHeaderGroup>
            <AuxiliaryPanelTitle>{title}</AuxiliaryPanelTitle>
          </AuxiliaryPanelHeaderGroup>
        </AuxiliaryPanelHeader>
      }
    >
      <AuxiliaryPanelBody className="overflow-y-auto overflow-x-hidden overscroll-contain px-4 pb-8">
        {children}
      </AuxiliaryPanelBody>
    </AuxiliaryPanel>
  );
}
