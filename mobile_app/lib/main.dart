import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

// URL oficial da KL Web
const String kSiteUrl = 'https://klweb.com.br'; 

const AndroidNotificationChannel channel = AndroidNotificationChannel(
  'high_importance_channel',
  'Notificações KL Web',
  description: 'Canal para alertas e atualizações da KL Web.',
  importance: Importance.high,
);

final FlutterLocalNotificationsPlugin flutterLocalNotificationsPlugin =
    FlutterLocalNotificationsPlugin();

bool firebaseReady = false;

@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp();
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  try {
    await Firebase.initializeApp();
    firebaseReady = true;
    FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);
  } catch (e) {
    debugPrint('Firebase não configurado: $e');
  }

  try {
    await flutterLocalNotificationsPlugin.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
    );
    await flutterLocalNotificationsPlugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(channel);
  } catch (e) {
    debugPrint('Notificações locais não iniciaram: $e');
  }

  runApp(const KLWebApp());
}

class KLWebApp extends StatelessWidget {
  const KLWebApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KL Web',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF00B4D8), // Azul vibrante baseado na logo
          brightness: Brightness.light,
        ),
        useMaterial3: true,
        fontFamily: 'Roboto',
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF00B4D8),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const MainNavigationScreen(),
    );
  }
}

class MainNavigationScreen extends StatefulWidget {
  const MainNavigationScreen({super.key});

  @override
  State<MainNavigationScreen> createState() => _MainNavigationScreenState();
}

class _MainNavigationScreenState extends State<MainNavigationScreen> {
  int _selectedIndex = 0;
  late final WebViewController controller;
  bool isLoading = true;
  bool hasError = false;
  String? fcmToken;

  @override
  void initState() {
    super.initState();
    _initController();
    _initPush();
  }

  void _initController() {
    controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.transparent)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (String url) {
            if (!mounted) return;
            setState(() {
              isLoading = true;
              hasError = false;
            });
          },
          onPageFinished: (String url) {
            if (!mounted) return;
            setState(() => isLoading = false);
            _injectToken();
            // Injeta classe CSS para esconder botões de download dentro do APK
            controller.runJavaScript("document.body.classList.add('is-app');");
          },
          onWebResourceError: (WebResourceError error) {
            if (error.isForMainFrame ?? true) {
              if (!mounted) return;
              setState(() {
                hasError = true;
                isLoading = false;
              });
            }
          },
          onNavigationRequest: _handleNavigation,
        ),
      )
      ..loadRequest(Uri.parse('assets/www/index.html'));
  }

  NavigationDecision _handleNavigation(NavigationRequest request) {
    final uri = Uri.tryParse(request.url);
    if (uri == null) return NavigationDecision.prevent;

    if (uri.scheme == 'about' || uri.scheme == 'data' || uri.scheme == 'blob') {
      return NavigationDecision.navigate;
    }

    final host = uri.host.toLowerCase();
    // Navegação restrita ao domínio KL Web
    if (host.contains('klweb.com.br')) {
      return NavigationDecision.navigate;
    }

    // Links externos abrem fora do app
    launchUrl(uri, mode: LaunchMode.externalApplication);
    return NavigationDecision.prevent;
  }

  Future<void> _initPush() async {
    if (!firebaseReady) return;
    try {
      final messaging = FirebaseMessaging.instance;
      await messaging.requestPermission(alert: true, badge: true, sound: true);
      fcmToken = await messaging.getToken();
      _injectToken();
      messaging.onTokenRefresh.listen((String newToken) {
        fcmToken = newToken;
        _injectToken();
      });
      FirebaseMessaging.onMessage.listen(_showForegroundNotification);
    } catch (e) {
      debugPrint('Erro ao iniciar notificações push: $e');
    }
  }

  void _showForegroundNotification(RemoteMessage message) {
    final notification = message.notification;
    if (notification == null) return;
    flutterLocalNotificationsPlugin.show(
      notification.hashCode,
      notification.title,
      notification.body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          channel.id,
          channel.name,
          channelDescription: channel.description,
          importance: Importance.high,
          priority: Priority.high,
          icon: '@mipmap/ic_launcher',
        ),
      ),
    );
  }

  void _injectToken() {
    final token = fcmToken;
    if (token == null) return;
    controller.runJavaScript(
      'window.KLE_FCM_TOKEN = ${jsonEncode(token)};'
      "if (typeof vincularTokenMobile === 'function') { vincularTokenMobile(); }",
    );
  }

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
    });

    switch (index) {
      case 0:
        controller.loadRequest(Uri.parse('assets/www/index.html'));
        break;
      case 1:
        controller.loadRequest(Uri.parse('assets/www/servicos'));
        break;
      case 2:
        controller.loadRequest(Uri.parse('assets/www/perfil'));
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvoked: (didPop) async {
        if (didPop) return;
        if (await controller.canGoBack()) {
          controller.goBack();
        } else {
          // ignore: use_build_context_synchronously
          Navigator.of(context).pop();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: Image.asset(
            'assets/logo.png',
            height: 38, // Altura ideal para AppBar (deixa respiro vertical)
            fit: BoxFit.contain,
            errorBuilder: (context, error, stackTrace) {
              return const Text(
                'KL WEB',
                style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 1.2),
              );
            },
          ),
          centerTitle: true,
          elevation: 0,
          actions: [
            IconButton(
              icon: const Icon(Icons.notifications_none),
              onPressed: () {},
            ),
          ],
        ),
        drawer: Drawer(
          child: ListView(
            padding: EdgeInsets.zero,
            children: [
              DrawerHeader(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      Theme.of(context).colorScheme.primary,
                      Theme.of(context).colorScheme.secondary,
                    ],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(4),
                      decoration: const BoxDecoration(
                        color: Colors.white,
                        shape: BoxShape.circle,
                      ),
                      child: ClipOval(
                        child: Image.asset(
                          'assets/logo.png',
                          height: 52, // Logo levemente maior no Drawer
                          width: 52,
                          fit: BoxFit.cover,
                          errorBuilder: (context, error, stackTrace) => const Icon(Icons.person, size: 40, color: Color(0xFF00B4D8)),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'Bem-vindo à KL Web',
                      style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold),
                    ),
                  ],
                ),
              ),
              ListTile(
                leading: const Icon(Icons.home_outlined),
                title: const Text('Início'),
                onTap: () {
                  Navigator.pop(context);
                  _onItemTapped(0);
                },
              ),
              ListTile(
                leading: const Icon(Icons.business_center_outlined),
                title: const Text('Serviços'),
                onTap: () {
                  Navigator.pop(context);
                  _onItemTapped(1);
                },
              ),
              ListTile(
                leading: const Icon(Icons.person_outline),
                title: const Text('Meu Perfil'),
                onTap: () {
                  Navigator.pop(context);
                  _onItemTapped(2);
                },
              ),
              const Divider(),
              ListTile(
                leading: const Icon(Icons.info_outline),
                title: const Text('Sobre a KL Web'),
                onTap: () {
                  Navigator.pop(context);
                },
              ),
            ],
          ),
        ),
        body: Stack(
          children: [
            WebViewWidget(controller: controller),
            if (isLoading && !hasError)
              Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const CircularProgressIndicator(),
                    const SizedBox(height: 20),
                    Text(
                      'Carregando KL Web...',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.primary,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              ),
            if (hasError) _buildErrorView(),
          ],
        ),
        bottomNavigationBar: BottomNavigationBar(
          currentIndex: _selectedIndex,
          onTap: _onItemTapped,
          selectedItemColor: const Color(0xFF00B4D8),
          unselectedItemColor: Colors.grey,
          type: BottomNavigationBarType.fixed,
          items: const [
            BottomNavigationBarItem(
              icon: Icon(Icons.home_outlined),
              activeIcon: Icon(Icons.home),
              label: 'Início',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.grid_view_outlined),
              activeIcon: Icon(Icons.grid_view),
              label: 'Serviços',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.person_outline),
              activeIcon: Icon(Icons.person),
              label: 'Perfil',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildErrorView() {
    return Container(
      color: Theme.of(context).colorScheme.surface,
      width: double.infinity,
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.wifi_off_rounded,
            size: 80,
            color: Theme.of(context).colorScheme.error,
          ),
          const SizedBox(height: 24),
          const Text(
            'Ops! Conexão perdida.',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 12),
          const Text(
            'Não conseguimos carregar a KL Web. Verifique sua internet e tente novamente.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, color: Colors.grey),
          ),
          const SizedBox(height: 32),
          FilledButton.icon(
            onPressed: () {
              setState(() {
                hasError = false;
                isLoading = true;
              });
              controller.loadRequest(Uri.parse(kSiteUrl));
            },
            icon: const Icon(Icons.refresh),
            label: const Text('Tentar Novamente'),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
            ),
          ),
        ],
      ),
    );
  }
}
