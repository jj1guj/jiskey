#!/bin/bash

# ヘルプメッセージの表示
show_help() {
    echo "Usage: $0 [OPTIONS] <branch_name> <tag_name>"
    echo ""
    echo "Arguments:"
    echo "  branch_name    Name of the branch to work with"
    echo "  tag_name       Name of the tag to create"
    echo ""
    echo "Options:"
    echo "  --help         Show this help message and exit"
    echo ""
    echo "Examples:"
    echo "  $0 main v1.0.0"
    echo "  $0 develop v2.1.0-beta"
}

# ヘルプオプションのチェック
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    show_help
    exit 0
fi

# 引数のチェック
if [ $# -ne 2 ]; then
    echo "Error: Invalid number of arguments"
    echo ""
    show_help
    exit 1
fi

BRANCH_NAME=$1
TAG_NAME=$2

echo "Branch name: $BRANCH_NAME"
echo "Tag name: $TAG_NAME"

echo "Ferch origin"
git fetch origin

echo "Ferch upstream tags"
git fetch upstream --tags

# ブランチの存在確認
echo "Checking if branch '$BRANCH_NAME' exists..."
if git show-ref --verify --quiet refs/heads/$BRANCH_NAME; then
    echo "✅ Branch '$BRANCH_NAME' exists"
else
    echo "❌ Error: Branch '$BRANCH_NAME' does not exist"
    exit 1
fi

# タグの存在確認
echo "Checking if tag '$TAG_NAME' exists..."
if git show-ref --verify --quiet refs/tags/$TAG_NAME; then
    echo "✅ Branch '$TAG_NAME' exists"
else
    echo "❌ Error: Branch '$TAG_NAME' does not exist"
    exit 1
fi

# マージコンフリクトの確認
git checkout $BRANCH_NAME
echo "Checking for potential merge conflicts..."
if git merge-tree $(git merge-base $BRANCH_NAME $TAG_NAME) $BRANCH_NAME $TAG_NAME | grep -q "<<<<<<< "; then
    echo "⚠️  Warning: Potential merge conflicts detected!"
    echo "Conflicts may occur during merge. Do you want to proceed? (y/N)"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "Merge cancelled by user"
        exit 1
    fi
else
    echo "✅ No merge conflicts detected"
fi

echo "Performing merge..."
git checkout $BRANCH_NAME
if git merge $TAG_NAME -m "Update Misskey $TAG_NAME"; then
    echo "✅ Merge completed successfully"
else
    echo "❌ Merge failed. Please resolve conflicts manually"
    exit 1
fi

git push origin $BRANCH_NAME
echo "✅ Changes pushed to origin/$BRANCH_NAME"
