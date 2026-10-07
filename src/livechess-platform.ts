export function liveChessInstallation(platform: string) {
  switch (platform) {
    case 'windows':
      return {
        defaultPath: 'C:\\Program Files\\Digital Game Technology\\DGT LiveChess',
        placeholder: 'C:\\Program Files\\Digital Game Technology\\DGT LiveChess',
        help: 'Choose the LiveChess installation folder containing its app and runtime folders.',
      };
    case 'macos':
      return {
        defaultPath: '',
        placeholder: '/Applications/DGT LiveChess.app',
        help: 'Enter the LiveChess .app bundle path, usually /Applications/DGT LiveChess.app. On Apple Silicon, the Intel LiveChess application requires Rosetta.',
      };
    case 'linux':
      return {
        defaultPath: '',
        placeholder: '/opt/DGTLiveChess',
        help: 'Enter the installed LiveChess root folder, usually /opt/DGTLiveChess, containing app/package.jar and its native launcher with bundled Java runtime.',
      };
    default:
      return {
        defaultPath: '',
        placeholder: 'LiveChess installation path',
        help: 'Enter the installation folder on Windows or Linux, or the .app bundle on macOS.',
      };
  }
}
