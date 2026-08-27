## 2026.8.0

### Client
- 

### Server
- inboxのキューが詰まる問題を修正

### Others
- 

## 2026.7.0

### Client
- Fix: iOS PWAでバックグラウンドからの復帰時に表示が崩れる・白画面になる問題を修正 (#137)

### Server
- Enhance: リモート配送の耐障害性を全面的に改善
	- 応答のないホストへの配送をホスト単位のサーキットブレーカーで抑制し、タイムアウト待ちがワーカーを占有して健全なホストへの配送を遅延させる問題を解消
	- 配送のタイムアウトを「接続確立8秒・全体15秒」に分離し、応答の遅いサーバーへの配送成功率を改善
	- 外向きDNSを改善: リゾルバ指定(outgoingDnsServers)、解決結果のstaleフォールバック、TTL失効前のバックグラウンド再解決、解決済みホスト一覧のRedis永続化による起動直後のプリウォーム
	- 一時的な失敗の再試行を高速化(エラー種別に応じたバックオフ)し、ホスト回復時には滞留していた配送を即時再開
	- ワーカーに空きがある間、再試行待ちの配送を前倒しで実行
	- 到達不能が48時間続いた配送ジョブは破棄するように
- Enhance: 過負荷保護: イベントループ遅延等の自己健全性シグナルに基づいて配送の同時実行数を自動的に絞る劣化モードを追加
- Enhance: 観測性: 配送失敗の所要時間・ソケット再利用状況、DNS解決の異常、プリウォーム状況をログに出力するように
- Enhance: 追加された設定項目(すべて任意): outgoingDnsServers、outgoingHttpKeepAlive
- Enhance: Redisに deliver:dns-warm-hosts、deliver:dns-stale-cache キーを使用するように(いずれもTTL付き、削除しても動作に支障なし)
- Enhance: 連合配送のIPv6対応: 配送先サーバーのIPv4が不安定な場合でもIPv6経由で配送を継続できるように。有効化にはホストのIPv6接続とDockerネットワークの設定が必要(設定例と注意点を compose_example.yml にコメントとして追記)

### Others
- 

## 2026.6.0

### Client
- 

### Server
- Dockerイメージ容量を削減
- DockerイメージビルドのCIが遅い問題を修正

### Others
- 

## 2026.5.0

### Client
- 

### Server
- 

### Others
- CIでDockerイメージをビルドするように
	- docker pull jj1guj/jiskey:latest でpullできるように

## 2026.3.2

### Client
- Enhance: ユーザーリストのタイムラインにおいてファイルが添付されたノートのみ表示できるように

### Server
- 

### Others
- 一部CIが失敗する問題を修正

## 2026.3.0

### Client
- Enhance: コントロールパネル->連合ページにおいて手動配信停止中のサーバーのみ表示できるように

### Server
- 

### Others
- 

## 2025.10.1

### Client
- 

### Server
- 

### Others
- Enhance: アップデートスクリプトを追加

## 2025.9.0

### Client
- Enhance: モバイル端末においてウィジェットが右から出るように
- Enhance: アンケートの選択肢を最大100に

### Server
- Enhance: ユーザーリストのタイムライン取得時のパフォーマンスの向上
