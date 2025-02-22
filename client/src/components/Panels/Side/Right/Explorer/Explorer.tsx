import { useEffect } from "react";
import styled from "styled-components";

import ExplorerButtons from "./ExplorerButtons";
import Folders from "./Folders";
import Workspaces from "./Workspaces";
import useExplorerContextMenu from "./useExplorerContextMenu";
import useNewItem from "./useNewItem";
import { PgEditor } from "../../../../../utils/pg";

const Explorer = () => {
  const { newItem } = useNewItem();
  const { renameItem, deleteItem } = useExplorerContextMenu();

  // Explorer keybinds
  useEffect(() => {
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (e.altKey && e.key.toUpperCase() === "N") newItem();
      else if (e.key === "F2") renameItem();
      else if (e.key === "Delete" && !PgEditor.isFocused()) {
        deleteItem();
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [newItem, renameItem, deleteItem]);

  return (
    <ExplorerWrapper>
      <Workspaces />
      <ExplorerButtons />
      <Folders />
    </ExplorerWrapper>
  );
};

const ExplorerWrapper = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  user-select: none;
  padding: 0 0.5rem;
`;

export default Explorer;
