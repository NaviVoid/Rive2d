use gtk::glib;
use gtk::prelude::*;
use gtk_layer_shell::LayerShell;
use std::sync::Mutex;
use tauri::Manager;
use webkit2gtk::{SecurityManagerExt, WebContextExt, WebViewExt as WkWebViewExt};

/// Holds a reference to the layer-shell GTK window so we can update its input region later.
pub struct LayerShellWindow(Mutex<Option<gtk::ApplicationWindow>>);

// SAFETY: gtk::ApplicationWindow is reference-counted (GObject). We only access it
// on the GTK main thread via glib::idle_add_once. The Mutex ensures exclusive access.
unsafe impl Send for LayerShellWindow {}
unsafe impl Sync for LayerShellWindow {}

impl LayerShellWindow {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn set(&self, window: gtk::ApplicationWindow) {
        *self.0.lock().unwrap() = Some(window);
    }

    pub fn get(&self) -> Option<gtk::ApplicationWindow> {
        self.0.lock().unwrap().clone()
    }
}

pub fn setup_layer_shell(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let main_window = app
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    let gtk_window = create_layer_shell_window(&main_window)?;
    let state = app.state::<LayerShellWindow>();
    state.set(gtk_window);
    Ok(())
}

pub fn setup_layer_shell_from_handle(
    app: &tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    let main_window = app
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    let gtk_window = create_layer_shell_window(&main_window)?;
    let state = app.state::<LayerShellWindow>();
    state.set(gtk_window);
    Ok(())
}

fn create_layer_shell_window(
    main_window: &tauri::WebviewWindow,
) -> Result<gtk::ApplicationWindow, Box<dyn std::error::Error>> {
    // Hide the original Tauri-managed window
    main_window.hide()?;

    // Get the original GTK window and its application
    let original_gtk_window = main_window.gtk_window()?;
    let gtk_app = original_gtk_window
        .application()
        .ok_or("Failed to get GTK Application")?;

    // Create a NEW ApplicationWindow (not yet realized)
    let new_gtk_window = gtk::ApplicationWindow::new(&gtk_app);

    // Set up transparency BEFORE realization
    new_gtk_window.set_app_paintable(true);
    if let Some(screen) = WidgetExt::screen(&new_gtk_window) {
        if let Some(visual) = screen.rgba_visual() {
            new_gtk_window.set_visual(Some(&visual));
        }
    }

    // Transfer the webview vbox from original window to new window
    let vbox = main_window.default_vbox()?;
    original_gtk_window.remove(&vbox);
    new_gtk_window.add(&vbox);

    // Initialize layer shell BEFORE the window is realized
    new_gtk_window.init_layer_shell();

    // Configure layer shell properties
    new_gtk_window.set_layer(gtk_layer_shell::Layer::Bottom);
    new_gtk_window.set_exclusive_zone(-1);
    new_gtk_window.set_keyboard_mode(gtk_layer_shell::KeyboardMode::None);
    new_gtk_window.set_namespace("rive2d-desktop-pet");

    // Anchor all 4 edges so the compositor fills the entire screen
    new_gtk_window.set_anchor(gtk_layer_shell::Edge::Top, true);
    new_gtk_window.set_anchor(gtk_layer_shell::Edge::Bottom, true);
    new_gtk_window.set_anchor(gtk_layer_shell::Edge::Left, true);
    new_gtk_window.set_anchor(gtk_layer_shell::Edge::Right, true);

    // Paint transparent background on the main GTK surface
    new_gtk_window.connect_draw(|_window, ctx| {
        ctx.set_source_rgba(0.0, 0.0, 0.0, 0.0);
        ctx.set_operator(gtk::cairo::Operator::Source);
        ctx.paint().expect("Failed to paint transparent background");
        glib::Propagation::Proceed
    });

    // Keep the main surface cleared to transparent every frame
    new_gtk_window.add_tick_callback(|window, _clock| {
        window.queue_draw();
        glib::ControlFlow::Continue
    });

    // Show the new window (this triggers realization with layer-shell active)
    new_gtk_window.show_all();

    if let Some(gdk_window) = new_gtk_window.window() {
        let empty_region = gtk::cairo::Region::create();
        // Empty input region so all clicks pass through initially
        gdk_window.input_shape_combine_region(&empty_region, 0, 0);
        // Empty opaque region tells the Wayland compositor that nothing is
        // opaque, so it must always composite this surface (not skip regions).
        gdk_window.set_opaque_region(Some(&empty_region));
    }

    // Set WebView background to transparent AFTER the window is realized,
    // so the WebProcess is ready to receive the setting.
    set_webview_transparent(&vbox);

    Ok(new_gtk_window)
}

/// Find the WebKitWebView and set its background to transparent.
/// Hardware acceleration stays ON so WebGL renders to its own Wayland subsurface,
/// bypassing the main surface's damage tracking issues entirely.
fn set_webview_transparent(container: &impl gtk::prelude::ContainerExt) {
    for child in container.children() {
        if let Ok(webview) = child.clone().downcast::<webkit2gtk::WebView>() {
            eprintln!("[rive2d] Setting WebView background to transparent");
            WkWebViewExt::set_background_color(&webview, &gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));

            // Register model:// as CORS-enabled so WebGL can use textures from it
            if let Some(ctx) = webview.web_context() {
                if let Some(sm) = ctx.security_manager() {
                    sm.register_uri_scheme_as_cors_enabled("model");
                    eprintln!("[rive2d] Registered model:// as CORS-enabled");
                }
            }

            return;
        }
        if let Ok(c) = child.downcast::<gtk::Container>() {
            set_webview_transparent(&c);
        }
    }
}

/// Update the GDK input region on the layer-shell window.
/// width/height <= 0 means "pass through everything" (empty region).
pub fn update_input_region(
    window: &gtk::ApplicationWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    if let Some(gdk_window) = window.window() {
        let region = if width > 0 && height > 0 {
            let rect = gtk::cairo::RectangleInt::new(x, y, width, height);
            gtk::cairo::Region::create_rectangle(&rect)
        } else {
            gtk::cairo::Region::create()
        };
        gdk_window.input_shape_combine_region(&region, 0, 0);
    }
}
