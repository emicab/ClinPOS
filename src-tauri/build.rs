// Los comandos propios de la app (invoke_handler en src/lib.rs) se declaran acá
// para generar sus permisos `allow-<comando>`. La interfaz se sirve desde
// http://localhost:3001 (origen remoto para Tauri) y, desde ese origen, Tauri
// rechaza con "Command ... not allowed by ACL" cualquier comando que no esté
// listado en una capacidad (ver capabilities/default.json).
fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "backup_database",
        "restore_database",
        "kill_server",
        "kill_stale_node_servers",
        "exit_for_update",
        "save_report_file",
      ]),
    ),
  )
  .expect("error al generar el manifiesto de la app");
}
