import { Dispatch } from "react";
import { SetStateAction } from "jotai";
import FS, { PromisifiedFS } from "@isomorphic-git/lightning-fs";
import JSZip from "jszip";
import { saveAs } from "file-saver";

import { ClassName, Id, ItemError, WorkspaceError } from "../../../constants";
import { PgProgramInfo, ProgramInfo } from "../program-info";
import { PgGithub } from "./github";
import { PgWorkspace, Workspaces } from "./workspace";

export interface ExplorerJSON {
  files: {
    [key: string]: ItemInfo;
  };
}

interface ItemInfo {
  content?: string;
  current?: boolean;
  tabs?: boolean;
}

export interface FullFile extends ItemInfo {
  path: string;
}

export interface Folder {
  folders: string[];
  files: string[];
}

interface TabFile {
  /** Relative paths of the tabs */
  tabs: string[];
  /** Relative path of the current file */
  currentPath?: string;
}

/** Array<[Path, Content]> */
export type Files = TupleString[];

export type TupleString = [string, string];

/**
 * Class that has both static and non-static methods for explorer.
 */
export class PgExplorer {
  /** Non-static methods */

  // Internal state
  private _explorer: ExplorerJSON;
  // IndexedDB FS object
  private _fs?: PromisifiedFS;
  // Workspace functionality
  private _workspace?: PgWorkspace;
  // Whether the user is on a shared page
  private _shared?: boolean;
  // To update ui
  private _refresh: () => void;

  /**
   * @param explorer state is shared if this param is supplied
   */
  constructor(
    refresh: Dispatch<SetStateAction<number>>,
    explorer?: ExplorerJSON
  ) {
    if (explorer) {
      this._shared = true;
      this._explorer = explorer;
    } else {
      this._fs = new FS(PgExplorer._INDEXED_DB_NAME).promises;
      this._explorer = {
        files: {},
      };
      this._workspace = new PgWorkspace();
    }

    this._refresh = () => refresh((c) => c + 1);
  }

  /** Get whether the current page is shared */
  get isShared() {
    return this._shared;
  }

  /** Get explorer files */
  get files() {
    return this._explorer.files;
  }

  /** Get full path of current workspace('/' appended) */
  get currentWorkspacePath() {
    return this._getWorkspacePath(
      this.currentWorkspaceName ?? PgWorkspace.DEFAULT_WORKSPACE_NAME
    );
  }

  /** Get current workspace name */
  get currentWorkspaceName() {
    return this._workspace?.currentName;
  }

  /** Get names of all workspaces */
  get allWorkspaceNames() {
    return this._workspace?.allNames;
  }

  /** Get current workspace's tab info file path */
  private get _tabInfoPath() {
    return this.currentWorkspacePath + PgWorkspace.TABINFO_PATH;
  }

  /** Get current workspace's program info file path */
  private get _programInfoPath() {
    return this.currentWorkspacePath + PgWorkspace.PROGRAM_INFO_PATH;
  }

  /** Public methods */

  /**
   * Initialize explorer with the specified workspace or the default workspace.
   *
   * Only the current workspace will be in the memory.
   *
   * @param workspace (optional) workspace name to set the current workspace
   *
   * IMPORTANT: This function must be called after constructing the class
   * if the project is not shared.
   */
  async init(workspace?: string): Promise<PgExplorer> {
    if (!this._workspace) {
      throw new Error(WorkspaceError.NOT_FOUND);
    }

    if (workspace) {
      this._workspace.setCurrentName(workspace);

      // Update workspaces file
      await this._saveWorkspaces();

      this._explorer.files = {};
    } else {
      // Initialize workspaces
      await this._initializeWorkspaces();
    }

    const fs = this._getFs();

    // Sets up the files from IndexedDB to the state
    const setupFiles = async (path: string) => {
      const itemNames = await fs.readdir(path);
      if (!itemNames.length) {
        // Empty directory
        this.files[path] = {};
        return;
      }

      const subItemPaths = itemNames.map(
        (itemName) => PgExplorer.appendSlash(path) + itemName
      );
      for (const subItemPath of subItemPaths) {
        const stat = await fs.stat(subItemPath);
        if (stat.isFile()) {
          const content = await this._readToString(subItemPath);
          this.files[subItemPath] = { content };
        } else {
          await setupFiles(subItemPath);
        }
      }
    };

    try {
      await setupFiles(this.currentWorkspacePath);
    } catch {
      console.log(
        "Couldn't setup files from IndexedDB. Probably need initial setup."
      );
    }

    // Runs when IndexedDB is empty
    if (!Object.keys(this.files).length) {
      console.log("Setting up default FS...");
      // For backwards compatibility reasons, we check whether explorer key is used in localStorage
      // and move the localStorage FS to IndexedDB.
      // TODO: delete this check after moving domains
      const lsExplorerStr = localStorage.getItem("explorer");
      if (lsExplorerStr) {
        const lsExplorer: ExplorerJSON = JSON.parse(lsExplorerStr);
        const lsFiles = lsExplorer.files;
        for (const path in lsFiles) {
          const data = lsFiles[path];
          delete lsFiles[path];
          lsFiles[
            path.replace(PgExplorer.ROOT_DIR_PATH, this.currentWorkspacePath)
          ] = data;
        }
        this._explorer.files = lsFiles;
      } else {
        // Show the default explorer if the files are empty
        this._explorer = { files: { "/src/": {} } };
      }

      // Save file(s) to IndexedDB
      await this._writeAllFromState();

      // Create tab info file
      await this.saveTabs({ initial: true });
    }

    // Load tab info from IndexedDB
    const tabStr = await this._readToString(this._tabInfoPath);
    const tabFile: TabFile = JSON.parse(tabStr);

    for (const relativePath of tabFile.tabs) {
      this.files[this.currentWorkspacePath + relativePath].tabs = true;
    }
    if (tabFile.currentPath) {
      this.files[this.currentWorkspacePath + tabFile.currentPath].current =
        true;
    }

    // Load program info from IndexedDB
    try {
      const programInfoStr = await this._readToString(this._programInfoPath);
      const programInfo: ProgramInfo = JSON.parse(programInfoStr);

      // Set program info in localStorage
      PgProgramInfo.update(programInfo);
    } catch {
      // Program info doesn't exist in IndexedDB
      // Create it from localStorage
      await this.saveProgramInfo();
    }

    return this;
  }

  /**
   * Saves tab and current file info to IndexedDB
   *
   * NOTE: Only runs when the project is not shared.
   */
  async saveTabs(options?: { initial?: boolean }) {
    if (!this.isShared) {
      if (options?.initial) {
        const tabFile: TabFile = { tabs: [] };
        await this._writeFile(this._tabInfoPath, JSON.stringify(tabFile), true);
        return;
      }

      const files = this.files;

      const tabs = [];
      let currentPath;
      for (const path in files) {
        const itemInfo = files[path];
        if (itemInfo?.tabs) tabs.push(this._getRelativePath(path));
        if (itemInfo?.current) currentPath = this._getRelativePath(path);
      }

      const tabFile: TabFile = { tabs, currentPath };

      console.log(`Saving file ${this._tabInfoPath}, ${tabFile.currentPath}`);

      await this._writeFile(this._tabInfoPath, JSON.stringify(tabFile), true);
    }
  }

  /**
   * Write program info from localStorage to workspace in IndexedDB
   */
  async saveProgramInfo() {
    if (!this.isShared) {
      await this._writeFile(
        this._programInfoPath,
        JSON.stringify(PgProgramInfo.getProgramInfo())
      );
    }
  }

  /**
   * Saves file to IndexedDB.
   *
   * NOTE: This function assumes parent directories exist.
   */
  async saveFileToIndexedDB(path: string, data: string) {
    if (!this.isShared) await this._fs?.writeFile(path, data);
  }

  /**
   * If the project is not shared(default):
   * - Name and path checks
   * - Create new item in IndexedDB
   * - If create is successful, also create the item in the state
   *
   * If the project is shared:
   * - Name and path checks
   * - Create item in the state
   */
  async newItem(fullPath: string) {
    // Invalid name
    if (
      !PgExplorer.isItemNameValid(PgExplorer.getItemNameFromPath(fullPath)!)
    ) {
      throw new Error(ItemError.INVALID_NAME);
    }

    const files = this.files;

    // Already exists
    if (files[fullPath]) throw new Error(ItemError.ALREADY_EXISTS);

    const itemType = PgExplorer.getItemTypeFromPath(fullPath);

    // Ordering of IndexedDB calls and state calls matter. If IndexedDB call fails,
    // state will not change. Can't say the same if the ordering was in reverse.
    if (itemType.file) {
      if (!this.isShared) {
        await this._writeFile(fullPath, "", true);
        await this.saveTabs();
      }

      files[fullPath] = {
        content: "",
        current: true,
        tabs: true,
      };

      this.changeCurrentFile(fullPath);
    } else {
      // Folder
      if (!this.isShared) {
        await this._mkdir(fullPath);
      }

      files[fullPath] = {};
    }

    await this.saveTabs();
  }

  /**
   * If the project is not shared(default):
   * - Name and path checks
   * - Rename in IndexedDB
   * - If rename is successful also rename item in the state
   *
   * If the project is shared:
   * - Name and path checks
   * - Rename in state
   */
  async renameItem(
    fullPath: string,
    newName: string,
    options?: { skipNameValidation?: boolean }
  ) {
    if (!options?.skipNameValidation && !PgExplorer.isItemNameValid(newName)) {
      console.log(newName, fullPath);
      throw new Error(ItemError.INVALID_NAME);
    }
    if (fullPath === this._getCurrentSrcPath()) {
      throw new Error(ItemError.SRC_RENAME);
    }

    const files = this.files;

    const itemType = PgExplorer.getItemTypeFromPath(fullPath);
    const newItemType = PgExplorer.getItemTypeFromName(newName);
    if (
      (itemType.file && !newItemType.file) ||
      (itemType.folder && !newItemType.folder)
    ) {
      throw new Error(ItemError.TYPE_MISMATCH);
    }

    const parentFolder = PgExplorer.getParentPathFromPath(fullPath);

    // Check to see if newName already exists
    const newPath = itemType.file
      ? parentFolder + newName
      : parentFolder + newName + "/";
    if (files[newPath]) throw new Error(ItemError.ALREADY_EXISTS);

    if (!this.isShared) {
      // Rename in IndexedDB
      const fs = this._getFs();
      await fs.rename(fullPath, newPath);
    }

    if (itemType.file) {
      // Store the file
      const file = files[fullPath];

      // Delete the old path and data
      delete files[fullPath];

      // Set the new path
      files[newPath] = file;
    } else {
      // We need to loop through all files in order to change every child path
      for (const path in files) {
        // /programs/my_program/logs/logfile.log
        // If we are renaming 'my_program' then we can replace '/programs/my_program/'
        // with '/programs/<new_name>/'
        if (path.startsWith(fullPath)) {
          const namesArr = fullPath.split("/");
          const pathWithoutName = namesArr
            .filter((_itemName, i) => i !== namesArr.length - 2)
            .reduce((acc, itemName) => (acc += `/${itemName}`));

          // This is the folder path
          const newFolderPath = pathWithoutName + newName + "/";

          // This is the full path that could be a children(newFolderPath + ...)
          const newFullPath = path.replace(fullPath, newFolderPath);

          // Check if newPath exists
          if (files[newFullPath]) throw new Error(ItemError.ALREADY_EXISTS);

          // Store the data
          const data = files[path];

          // Delete the old path and data
          delete files[path];

          // Set the new path with the data
          files[newFullPath] = data;
        }
      }
    }

    await this.saveTabs();
  }

  /**
   * If the project is not shared(default):
   * - Delete from IndexedDB(recursively)
   * - If delete is successful, delete from state
   *
   * If the project is shared:
   * - Delete from state
   */
  async deleteItem(fullPath: string) {
    // Can't delete src folder
    if (fullPath === this._getCurrentSrcPath()) {
      throw new Error(ItemError.SRC_DELETE);
    }

    if (!this.isShared) {
      const fs = this._getFs();

      const stat = await fs.stat(fullPath);
      if (stat.isFile()) await fs.unlink(fullPath);
      else await this._rmdir(fullPath, true);
    }

    const files = this.files;

    const isCurrentFile = files[fullPath]?.current;

    // If we are deleting current file's parent(s)
    // we need to update the current file to the last tab
    let isCurrentParent = false;
    if (this.getCurrentFile()?.path.startsWith(fullPath)) {
      isCurrentParent = true;
    }

    for (const path in files) {
      if (path.startsWith(fullPath)) {
        delete files[path];
      }
    }

    // If we delete all elements from a folder, the parent folder disappears too.
    // We are adding the folder back to mitigate that
    const parentPath = PgExplorer.getParentPathFromPath(fullPath);
    files[parentPath] = {};

    // Change current file to the last tab when current file is deleted
    // or current file's parent is deleted
    if (isCurrentFile || isCurrentParent) this.changeCurrentFileToTheLastTab();

    await this.saveTabs();
  }

  /**
   * Create a new workspace and change the current workspace to the created workspace
   * @param name new workspace name
   * @param options -
   * - files: Files to create the workspace from
   * - defaultOpenFile: Default file to open in the editor
   * - fromShared: Whether to create new workspace from a shared project
   */
  async newWorkspace(
    name: string,
    options?: { files?: Files; defaultOpenFile?: string; fromShared?: boolean }
  ) {
    name = name.trim();
    if (!name) throw new Error(WorkspaceError.INVALID_NAME);

    if (options?.fromShared && this.isShared) {
      // The reason we are not just getting the necessary files and re-calling this
      // function with { files } is because we would lose the tab info. Instead we
      // are creating a valid workspace state and writing it to IndexedDB.

      this._shared = false;
      this._fs = new FS(PgExplorer._INDEXED_DB_NAME).promises;
      this._workspace = new PgWorkspace();
      // Init workspace
      await this._initializeWorkspaces();
      // Create a new workspace in state
      this._workspace.new(name);

      // Change state paths(shared projects start with /src)
      for (const path in this.files) {
        const data = this.files[path];
        delete this.files[path];
        this.files[`/${name}${path}`] = data;
      }

      // Save everything from state to IndexedDB
      await this._writeAllFromState();

      // Save tabs
      await this.saveTabs();

      await this.changeWorkspace(name);

      return;
    }

    if (!this._workspace) {
      throw new Error(WorkspaceError.NOT_FOUND);
    }

    // Save tabs before initializing so data is never lost
    if (this.hasWorkspaces()) await this.saveTabs();

    // Create a new workspace in state
    this._workspace.new(name);

    // Create src folder
    await this._mkdir(this._getCurrentSrcPath(), true);

    // Create files
    if (options?.files) {
      for (const pathContent of options?.files) {
        const fullPath = this._getCurrentSrcPath() + pathContent[0];
        const content = pathContent[1];
        await this._writeFile(fullPath, content, true);
      }
    }

    await this.changeWorkspace(name, {
      initial: true,
      defaultOpenFile: options?.defaultOpenFile,
    });
  }

  /**
   * Change the current workspace to the given workspace
   * @param name workspace name to change to
   * @param options -
   * - initial: if changing to the given workspace for the first time
   * - defaultOpenFile: the file to open in the editor
   */
  async changeWorkspace(
    name: string,
    options?: { initial?: boolean; defaultOpenFile?: string }
  ) {
    // Save tabs before changing the workspace to never lose data
    await this.saveTabs(options);

    // Remove the current program info from localStorage
    PgProgramInfo.reset();

    await this.init(name);

    // Open the lib file if it has been specified
    if (options?.defaultOpenFile) {
      this.changeCurrentFile(
        this._getCurrentSrcPath() + options.defaultOpenFile
      );
    }

    this._refresh();
  }

  /**
   * Rename the current workspace
   * @param newName new workspace name
   */
  async renameWorkspace(newName: string) {
    newName = newName.trim();
    if (!newName) {
      throw new Error(WorkspaceError.INVALID_NAME);
    }
    if (!this._workspace) {
      throw new Error(WorkspaceError.NOT_FOUND);
    }
    if (this.currentWorkspaceName === newName) {
      throw new Error(WorkspaceError.ALREADY_EXISTS);
    }

    await this.renameItem(this.currentWorkspacePath, newName, {
      skipNameValidation: true,
    });

    // Rename workspace in state
    this._workspace.rename(newName);

    await this.changeWorkspace(newName);
  }

  /**
   * Delete the current workspace
   */
  async deleteWorkspace() {
    if (!this._workspace) {
      throw new Error(WorkspaceError.NOT_FOUND);
    }
    if (!this.currentWorkspaceName) {
      throw new Error(WorkspaceError.CURRENT_NOT_FOUND);
    }

    // Delete from state
    this._workspace.delete(this.currentWorkspaceName);

    await this.deleteItem(this.currentWorkspacePath);

    const workspaceCount = this._workspace.allNames.length;
    if (workspaceCount) {
      const lastWorkspace = this._workspace.allNames[workspaceCount - 1];
      await this.changeWorkspace(lastWorkspace, { initial: true });
    } else {
      this._workspace.setCurrent({ allNames: [] });
      await this._saveWorkspaces();
      this._refresh();
    }
  }

  /**
   * Export the current workspace as a zip file
   */
  async exportWorkspace() {
    const fs = this._getFs();

    const zip = new JSZip();

    const recursivelyGetItems = async (path: string) => {
      const itemNames = await fs.readdir(path);
      if (!itemNames.length) return;

      const subItemPaths = itemNames
        .filter((itemName) => !itemName.startsWith("."))
        .map((itemName) => PgExplorer.appendSlash(path) + itemName);

      for (const subItemPath of subItemPaths) {
        const stat = await fs.stat(subItemPath);
        const relativePath = this._getRelativePath(subItemPath);
        if (stat.isFile()) {
          const content = await this._readToString(subItemPath);
          zip.file(relativePath, content);
        } else {
          zip.folder(relativePath);
          await recursivelyGetItems(subItemPath);
        }
      }
    };

    await recursivelyGetItems(this.currentWorkspacePath);

    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, this.currentWorkspaceName + ".zip");
  }

  /**
   * Create a new workspace from the url
   *
   * @param url Github url to a program's content(folder or single file)
   */
  async importFromGithub(url: string) {
    const { files, owner, repo, path } = await PgGithub.getImportableRepository(
      url
    );
    await this.newWorkspace(`github-${owner}/${repo}/${path}`, {
      files,
      defaultOpenFile: files.length === 1 ? files[0][0] : "lib.rs",
    });
  }

  /** State methods */

  /**
   * Save the file to the state only.
   */
  saveFileToState(path: string, content: string) {
    const files = this.files;

    if (files[path]) files[path].content = content;
  }

  /**
   * @returns all the files from state that are in tabs
   */
  getTabs() {
    const files = this.files;
    const tabs: FullFile[] = [];

    for (const path in files) {
      const fileInfo: ItemInfo = files[path];

      if (fileInfo.tabs)
        tabs.push({
          path,
          current: fileInfo.current,
        });
    }

    return tabs;
  }

  /**
   * Gets the current opened file from state if it exists
   */
  getCurrentFile() {
    const files = this.files;

    for (const path in files) {
      const fileInfo: ItemInfo = files[path];

      if (fileInfo.current) {
        const currentFile: FullFile = { content: fileInfo.content, path };
        return currentFile;
      }
    }

    return null;
  }

  /**
   * Changes the current opened file in state if it exists
   */
  changeCurrentFile(newPath: string) {
    const files = this.files;

    const curFile = this.getCurrentFile();

    if (curFile) files[curFile.path].current = false;

    // Add file to the tabs and current
    files[newPath].tabs = true;
    files[newPath].current = true;
  }

  /**
   * Changes current file to the last opened tab if it exists
   */
  changeCurrentFileToTheLastTab() {
    const tabs = this.getTabs();
    if (!tabs.length) return;

    const lastTabPath = tabs[tabs.length - 1].path;
    this.changeCurrentFile(lastTabPath);
  }

  /**
   * Closes the tab and changes the current file to the last opened tab if it exists
   */
  closeTab(path: string) {
    const files = this.files;
    files[path].tabs = false;

    // If we are closing the current file, change current file to the last tab
    if (files[path].current) {
      files[path].current = false;
      this.changeCurrentFileToTheLastTab();
    }
  }

  /**
   * Gets items inside the folder and groups them into `folders` and `files`
   */
  getFolderContent(path: string) {
    const files = this.files;
    const filesAndFolders: Folder = { folders: [], files: [] };

    for (const itemPath in files) {
      if (itemPath.startsWith(path)) {
        const item = itemPath.split(path)[1].split("/")[0];
        if (
          !filesAndFolders.files.includes(item) &&
          !filesAndFolders.folders.includes(item) &&
          item
        ) {
          // It's a file if it contains '.'
          // TODO: Implement a better system for folders and files
          if (item.includes(".")) filesAndFolders.files.push(item);
          else filesAndFolders.folders.push(item);
        }
      }
    }

    return filesAndFolders;
  }

  /**
   * @returns the necessary data for the build request
   */
  getBuildFiles() {
    const programPkStr = (
      PgProgramInfo.getPk().programPk ?? PgProgramInfo.createNewKp().publicKey
    ).toBase58();

    const updateIdRust = (content: string) => {
      const regex = new RegExp(/^(\s)*(\w*::)?declare_id!\("(\w*)"\)/gm);
      return content.replace(regex, (match) => {
        const res = regex.exec(match);
        if (!res) return match;

        // res[2] could be solana_program:: or undefined
        return (res[2] ?? "") + `declare_id!("${programPkStr}")`;
      });
    };

    const updateIdPython = (content: string) => {
      return content.replace(
        /^declare_id\(("|')(\w*)("|')\)/gm,
        () => `declare_id('${programPkStr}')`
      );
    };

    const getUpdatedProgramIdContent = (path: string) => {
      let content = files[path].content;
      if (content) {
        if (path.endsWith("lib.rs")) {
          content = updateIdRust(content);
        } else if (path.endsWith(".py")) {
          content = updateIdPython(content);
        }
      }

      return content;
    };

    const files = this.files;
    const buildFiles: Files = [];

    if (this.isShared) {
      for (const path in files) {
        // Shared files are already in correct format, we only update program id
        const updatedContent = getUpdatedProgramIdContent(path);
        if (!updatedContent) continue;
        buildFiles.push([path, updatedContent]);
      }
    } else {
      for (let path in files) {
        if (!path.startsWith(this._getCurrentSrcPath())) continue;

        const updatedContent = getUpdatedProgramIdContent(path);
        if (!updatedContent) continue;

        // We are removing the workspace from path because build only needs /src
        path = path.replace(
          this.currentWorkspacePath,
          PgExplorer.ROOT_DIR_PATH
        );

        buildFiles.push([path, updatedContent]);
      }
    }

    return buildFiles;
  }

  /**
   * @returns the necessary data for a new share
   */
  getShareFiles() {
    // Shared files are already in a valid form to share
    if (this.isShared) return { files: this._explorer.files };

    const files = this.files;

    const shareFiles: ExplorerJSON = { files: {} };

    for (let path in files) {
      if (!path.startsWith(this._getCurrentSrcPath())) continue;

      const itemInfo = files[path];

      // We are removing the workspace from path because share only needs /src
      path = path.replace(this.currentWorkspacePath, PgExplorer.ROOT_DIR_PATH);

      shareFiles.files[path] = itemInfo;
    }

    if (!Object.keys(shareFiles.files).length) throw new Error("Empty share");

    return shareFiles;
  }

  /**
   * @returns the file content if it exists in the state
   */
  getFileContentFromPath(path: string) {
    if (!this.isShared) {
      path = path.startsWith("/") ? path.substring(1) : path;
      path = this.currentWorkspacePath + path;
    }

    return this.files[path]?.content;
  }

  /**
   * @returns whether the current file in the state is a Rust file
   */
  isCurrentFileRust() {
    return this.getCurrentFile()?.path.endsWith(".rs");
  }

  /**
   * @returns whether the current file in the state is a Python file
   */
  isCurrentFilePython() {
    return this.getCurrentFile()?.path.endsWith(".py");
  }

  /**
   * @returns whether the user has any workspaces
   */
  hasWorkspaces() {
    return (this._workspace?.allNames?.length ?? 0) > 0;
  }

  /**
   * Get the path without the workspace path prefix
   *
   * @param p Full path
   * @returns Relative path
   */
  _getRelativePath(p: string) {
    return p.split(this.currentWorkspacePath)[1];
  }

  /** Private methods */

  /**
   * @returns the in-memory FS.
   *
   * This function will throw an error if FS doesn't exist.
   */
  private _getFs() {
    const fs = this._fs;
    if (!fs) throw new Error(ItemError.FS_NOT_FOUND);
    return fs;
  }

  /**
   * @returns whether the given path exists
   */
  private async _exists(path: string) {
    try {
      const fs = this._getFs();
      await fs.stat(path);
      return true;
    } catch (e: any) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
      else {
        console.log("Unknown error in _exists: ", e);
        throw e;
      }
    }
  }

  /**
   * Creates new directory with create parents optionality
   */
  private async _mkdir(path: string, createParents?: boolean) {
    const fs = this._getFs();

    if (createParents) {
      const folders = path.split("/");
      let _path = "";
      for (let i = 1; i < folders.length - 1; i++) {
        _path += "/" + folders[i];

        // Only create if the dir doesn't exist
        const exists = await this._exists(_path);
        if (!exists) await fs.mkdir(_path);
      }
    } else {
      await fs.mkdir(path);
    }
  }

  /**
   * Write file with create parents optionality.
   */
  private async _writeFile(
    path: string,
    data: string,
    createParents?: boolean
  ) {
    if (createParents) {
      const parentFolder = PgExplorer.getParentPathFromPath(path);
      await this._mkdir(parentFolder, true);
    }

    await this._getFs().writeFile(path, data);
  }

  /**
   * Write all data in the state to IndexedDB
   */
  private async _writeAllFromState() {
    for (const path in this.files) {
      const itemType = PgExplorer.getItemTypeFromPath(path);
      if (itemType.file) {
        await this._writeFile(path, this.files[path].content ?? "", true);
      } else {
        await this._mkdir(path, true);
      }
    }
  }

  /**
   * Reads file and returns the converted file string
   */
  private async _readToString(path: string) {
    const data = await this._getFs().readFile(path);
    return data.toString();
  }

  /**
   * Remove directory with recursive optionality
   */
  private async _rmdir(path: string, recursive?: boolean) {
    const fs = this._getFs();

    if (recursive) {
      const recursivelyRmdir = async (dir: string[], currentPath: string) => {
        if (!dir.length) {
          // Delete if it's an empty directory
          await fs.rmdir(currentPath);
          return;
        }

        for (const childName of dir) {
          const childPath = currentPath + childName;
          const type = (await fs.stat(childPath)).type;
          if (type === "dir") {
            const childDir = await fs.readdir(childPath);
            if (childDir.length) {
              await recursivelyRmdir(childDir, childPath + "/");
            } else await fs.rmdir(childPath);
          } else {
            await fs.unlink(childPath);
          }
        }

        // Read the directory again and delete if it's empty
        const _dir = await fs.readdir(currentPath);
        if (!_dir.length) await fs.rmdir(currentPath);
      };

      const dir = await fs.readdir(path);
      await recursivelyRmdir(dir, path);
    } else {
      await fs.rmdir(path);
    }
  }

  /**
   * Initialize workspaces from IndexedDB to state
   */
  private async _initializeWorkspaces() {
    if (!this._workspace) {
      throw new Error(WorkspaceError.NOT_FOUND);
    }

    let workspaces: Workspaces;
    try {
      const workspacesStr = await this._readToString(
        PgWorkspace.WORKSPACES_CONFIG_PATH
      );
      workspaces = JSON.parse(workspacesStr);
    } catch {
      // Create default workspaces file
      const defaultWorkspaces = PgWorkspace.default();
      await this._saveWorkspaces();
      workspaces = defaultWorkspaces;
    }

    this._workspace.setCurrent(workspaces);
  }

  /**
   * Saves workspaces from state to IndexedDB
   */
  private async _saveWorkspaces() {
    if (this._workspace) {
      await this._writeFile(
        PgWorkspace.WORKSPACES_CONFIG_PATH,
        JSON.stringify(this._workspace.get()),
        true
      );
    }
  }

  /**
   *
   * @returns current workspace's src directory path
   */
  private _getCurrentSrcPath() {
    return this.currentWorkspacePath + "src/";
  }

  /**
   * @param name workspace name
   * @returns the full path to the workspace root dir with '/' at the end
   */
  private _getWorkspacePath(name: string) {
    return PgExplorer.ROOT_DIR_PATH + PgExplorer.appendSlash(name);
  }

  /** Static methods */
  static readonly ROOT_DIR_PATH = "/";

  /** Don't change this! */
  private static readonly _INDEXED_DB_NAME = "solana-playground";

  static getItemNameFromPath(path: string) {
    const itemsArr = path.split("/");
    const itemType = this.getItemTypeFromPath(path);

    if (itemType.file) return itemsArr[itemsArr.length - 1];
    else return itemsArr[itemsArr.length - 2];
  }

  // TODO: Implement a better identifier
  static getItemTypeFromName(itemName: string) {
    if (itemName.includes(".")) return { file: true };
    return { folder: true };
  }

  static getItemTypeFromPath(path: string) {
    if (path.endsWith("/")) return { folder: true };
    return { file: true };
  }

  static getItemTypeFromEl = (el: HTMLDivElement) => {
    if (el.classList.contains(ClassName.FOLDER)) {
      return { folder: true };
    } else if (el.classList.contains(ClassName.FILE)) {
      return { file: true };
    }

    return null;
  };

  static getItemPathFromEl = (el: HTMLDivElement) => {
    return el?.getAttribute("data-path");
  };

  /**
   * Gets the parent folder path with '/' appended at the end.
   */
  static getParentPathFromPath(path: string) {
    const itemType = this.getItemTypeFromPath(path);

    const names = path.split("/");
    const parentPath = path
      .split("/")
      .filter((_itemName, i) => i !== names.length - (itemType.file ? 1 : 2))
      .reduce((acc, itemName) => {
        if (itemName) return (acc += `/${itemName}`);
        return acc;
      });

    return parentPath + "/";
  }

  static getParentPathFromEl = (selected: HTMLDivElement | null) => {
    if (!selected) return null;

    const itemType = this.getItemTypeFromEl(selected);

    if (itemType?.folder) {
      return selected?.getAttribute("data-path");
    } else if (itemType?.file) {
      // The file's owner folder is parent element's previous sibling
      return selected.parentElement!.previousElementSibling!.getAttribute(
        "data-path"
      );
    }

    return null;
  };

  static getElFromPath(path: string) {
    return document.querySelector(`[data-path='${path}']`) as HTMLDivElement;
  }

  static getRootFolderEl() {
    return document.getElementById(Id.ROOT_DIR);
  }

  static getSelectedEl = () => {
    return document.getElementsByClassName(
      ClassName.SELECTED
    )[0] as HTMLDivElement;
  };

  static setSelectedEl = (newEl: HTMLDivElement) => {
    const selectedEl = this.getSelectedEl();
    selectedEl?.classList.remove(ClassName.SELECTED);
    newEl.classList.add(ClassName.SELECTED);
  };

  static getCtxSelectedEl() {
    return document.getElementsByClassName(ClassName.CTX_SELECTED)[0];
  }

  static removeCtxSelectedEl() {
    this.getCtxSelectedEl()?.classList.remove(ClassName.CTX_SELECTED);
  }

  static openFolder = (el: HTMLDivElement) => {
    // Folder icon
    el.classList.add(ClassName.OPEN);

    // Toggle inside folder
    const insideFolderEl = el.nextElementSibling;
    if (insideFolderEl) insideFolderEl.classList.remove(ClassName.HIDDEN);
  };

  static toggleFolder = (el: HTMLDivElement) => {
    // Folder icon
    el.classList.toggle(ClassName.OPEN);

    // Toggle inside folder
    const insideFolderEl = el.nextElementSibling;
    if (insideFolderEl) insideFolderEl.classList.toggle(ClassName.HIDDEN);
  };

  static openAllParents(path: string) {
    for (;;) {
      const parentPath = this.getParentPathFromPath(path);
      const parentEl = this.getElFromPath(parentPath);

      if (!parentEl) break;

      this.openFolder(parentEl);
      if (parentPath === "/") break;

      path = parentPath;
    }
  }

  static collapseAllFolders() {
    let rootEl = this.getRootFolderEl();

    for (;;) {
      if (!rootEl || !rootEl.childElementCount) break;
      // Close folder
      rootEl.children[0]?.classList.remove(ClassName.OPEN);
      rootEl.children[1]?.classList.add(ClassName.HIDDEN);
      // Remove selected
      const selectedEl = this.getSelectedEl();
      if (selectedEl) selectedEl.classList.remove(ClassName.SELECTED);

      rootEl = rootEl?.children[1] as HTMLElement;
    }
  }

  static isItemNameValid(name: string) {
    return (
      name.match(/^(?!\.)[\w.-]+$/) &&
      !name.includes("//") &&
      !name.includes("..")
    );
  }

  static getExplorerIconsPath(name: string) {
    return "icons/explorer/" + name;
  }

  static appendSlash(path: string) {
    if (!path) return "";
    return path + (path.endsWith("/") ? "" : "/");
  }
}
