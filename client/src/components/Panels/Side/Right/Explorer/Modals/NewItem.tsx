import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useAtom } from "jotai";
import styled from "styled-components";

import LangIcon from "../../../../../LangIcon";
import Input, { defaultInputProps } from "../../../../../Input";
import {
  ctxSelectedAtom,
  explorerAtom,
  newItemAtom,
  refreshExplorerAtom,
} from "../../../../../../state";
import { PgExplorer } from "../../../../../../utils/pg";

export const NewItem = () => {
  const [explorer] = useAtom(explorerAtom);
  const [, refresh] = useAtom(refreshExplorerAtom);
  const [el, setEl] = useAtom(newItemAtom);
  const [ctxSelected, setCtxSelected] = useAtom(ctxSelectedAtom);

  const [itemName, setItemName] = useState("");

  const newFileRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClickOut = useCallback(
    (e: globalThis.MouseEvent) => {
      if (!newFileRef.current?.contains(e.target as Node)) setEl(null);
    },
    [setEl]
  );

  // Only allow setting filename with Enter
  // Escape closes the input
  const handleKeyPress = useCallback(
    async (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter") {
        if (!itemName || !explorer) return;

        // Check if the command is coming from context menu
        let selected = ctxSelected;
        if (!selected) selected = PgExplorer.getSelectedEl();
        const parentPath =
          PgExplorer.getParentPathFromEl(selected as HTMLDivElement) ?? "/";

        const convertedItemName =
          itemName + (PgExplorer.getItemTypeFromName(itemName).file ? "" : "/");

        const itemPath = parentPath + convertedItemName;

        try {
          await explorer.newItem(itemPath);

          // File add successfull

          // Remove input
          setEl(null);

          // Reset Ctx Selected
          setCtxSelected(null);

          // Trigger refresh on components that have explorerRefreshAtom
          refresh();

          // Select new file
          PgExplorer.setSelectedEl(PgExplorer.getElFromPath(itemPath));
        } catch (e: any) {
          console.log(e.message);
        }
      } else if (e.key === "Escape") setEl(null);
    },
    [itemName, explorer, ctxSelected, setEl, setCtxSelected, refresh]
  );

  useEffect(() => {
    if (el) {
      document.body.addEventListener("mousedown", handleClickOut);
      document.body.addEventListener("keydown", handleKeyPress);
      inputRef.current?.focus();
    }

    return () => {
      document.body.removeEventListener("mousedown", handleClickOut);
      document.body.removeEventListener("keydown", handleKeyPress);
    };
  }, [el, setEl, handleClickOut, handleKeyPress]);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setItemName(e.target.value);
    },
    [setItemName]
  );

  return el
    ? ReactDOM.createPortal(
        <Wrapper ref={newFileRef}>
          <LangIcon fileName={itemName} />
          <Input
            ref={inputRef}
            onChange={handleChange}
            {...defaultInputProps}
          />
        </Wrapper>,
        el
      )
    : null;
};

const Wrapper = styled.div`
  display: flex;
  align-items: center;
  padding: 0.25rem 0;

  & > input {
    margin-left: 0.375rem;
  }
`;
